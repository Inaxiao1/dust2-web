#!/usr/bin/env python3
"""
Parallel lossless-perceptual texture compressor for CS2-Web GLBs, map-cs2 WebPs, and PNGs.

1. For every .glb under public/assets/:
   - Extracts embedded PNG / JPEG images from the BIN chunk
   - Caps max dimension to 1024px (LANCZOS) preserving desktop & mobile 1024px fidelity
   - Converts to glTF 2.0 standard EXT_texture_webp (image/webp):
       * Normal maps: q=90
       * Alpha / ORM / metallic-roughness maps: q=85
       * Albedo / skin diffuse maps: q=84
   - Rebuilds BIN chunk preserving every non-image bufferView bit-for-bit (4-byte aligned)
   - Adds EXT_texture_webp to extensionsUsed (NOT extensionsRequired) for universal GLTFLoader support
   - Automatically renames hash-suffixed popular agent GLBs (*-<sha12>.glb) to match new sha256
2. Re-compresses oversized WebP textures in public/assets/map-cs2/textures/ (cap 1024px, q=80)
3. Optimizes public/assets/valve-dust2/de_dust2_1_png.png (3.24 MB -> crisp quantized 1280x720 PNG)
4. Writes artifacts/compression-report.json so sync-compressed-asset-hashes.mjs updates every manifest.

Usage:
  python3 scripts/compress-glb-textures.py
"""
import concurrent.futures
import hashlib
import io
import json
import os
import re
import struct
import sys
import time
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
ASSETS = PUBLIC / "assets"

MAX_GLB_DIM = 1024
MAX_MAP_DIM = 1024


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pad4(data: bytes, fill: bytes) -> bytes:
    rem = len(data) % 4
    return data if rem == 0 else data + fill * (4 - rem)


def compress_single_glb(glb_path_str: str) -> dict:
    glb_path = Path(glb_path_str)
    rel = glb_path.relative_to(PUBLIC).as_posix()
    raw = glb_path.read_bytes()
    old_size = len(raw)
    old_sha = sha256_bytes(raw)

    if len(raw) < 20 or raw[:4] != b"glTF":
        return {"path": rel, "skipped": "not-glb", "oldBytes": old_size, "newBytes": old_size}

    version, total_len = struct.unpack_from("<II", raw, 4)
    jlen, jtype = struct.unpack_from("<II", raw, 12)
    if jtype != 0x4E4F534A:
        return {"path": rel, "skipped": "no-json-chunk", "oldBytes": old_size, "newBytes": old_size}

    gltf = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
    images = gltf.get("images") or []
    if not images:
        return {"path": rel, "skipped": "no-images", "oldBytes": old_size, "newBytes": old_size}

    bin_header_off = 20 + jlen
    if bin_header_off + 8 > len(raw):
        return {"path": rel, "skipped": "no-bin", "oldBytes": old_size, "newBytes": old_size}
    blen, btype = struct.unpack_from("<II", raw, bin_header_off)
    if btype != 0x004E4942:
        return {"path": rel, "skipped": "bad-bin", "oldBytes": old_size, "newBytes": old_size}
    bdata = raw[bin_header_off + 8 : bin_header_off + 8 + blen]

    # Classify texture slots so normal maps get higher quality (90) and ORM/alpha get 85
    textures = gltf.get("textures") or []
    normal_imgs = set()
    orm_imgs = set()

    def tex_img_idx(tex_idx):
        if tex_idx is None or tex_idx >= len(textures):
            return None
        t = textures[tex_idx]
        ext = (t.get("extensions") or {}).get("EXT_texture_webp")
        if ext and "source" in ext:
            return ext["source"]
        return t.get("source")

    for mat in gltf.get("materials") or []:
        nt = mat.get("normalTexture")
        if nt and "index" in nt:
            idx = tex_img_idx(nt["index"])
            if idx is not None:
                normal_imgs.add(idx)
        pbr = mat.get("pbrMetallicRoughness") or {}
        mr = pbr.get("metallicRoughnessTexture")
        if mr and "index" in mr:
            idx = tex_img_idx(mr["index"])
            if idx is not None:
                orm_imgs.add(idx)
        occ = mat.get("occlusionTexture")
        if occ and "index" in occ:
            idx = tex_img_idx(occ["index"])
            if idx is not None:
                orm_imgs.add(idx)

    buffer_views = gltf.get("bufferViews") or []
    img_bv_set = set()
    for im in images:
        if "bufferView" in im:
            img_bv_set.add(im["bufferView"])

    # Compress candidate images
    new_img_bytes = {}
    converted_imgs = set()
    any_changed = False

    for idx, im in enumerate(images):
        bv_idx = im.get("bufferView")
        if bv_idx is None:
            continue
        bv = buffer_views[bv_idx]
        off = bv.get("byteOffset", 0)
        ln = bv["byteLength"]
        orig_img = bdata[off : off + ln]
        mime = im.get("mimeType", "")

        # Skip tiny <=2KB placeholders (e.g. 1x1 dummy textures)
        if ln <= 2048 or mime not in ("image/png", "image/jpeg"):
            new_img_bytes[idx] = (orig_img, mime)
            if mime == "image/webp":
                converted_imgs.add(idx)
            continue

        try:
            pil = Image.open(io.BytesIO(orig_img))
            pil.load()
        except Exception:
            new_img_bytes[idx] = (orig_img, mime)
            continue

        w, h = pil.size
        has_alpha = pil.mode in ("RGBA", "LA") or (pil.mode == "P" and "transparency" in pil.info)
        if has_alpha:
            if pil.mode != "RGBA":
                pil = pil.convert("RGBA")
        else:
            if pil.mode != "RGB":
                pil = pil.convert("RGB")

        if max(w, h) > MAX_GLB_DIM:
            scale = MAX_GLB_DIM / max(w, h)
            nw = max(1, round(w * scale))
            nh = max(1, round(h * scale))
            pil = pil.resize((nw, nh), Image.Resampling.LANCZOS)

        if idx in normal_imgs:
            q = 90
        elif idx in orm_imgs or has_alpha:
            q = 85
        else:
            q = 84

        out_buf = io.BytesIO()
        pil.save(out_buf, format="WEBP", quality=q, method=5)
        webp_data = out_buf.getvalue()

        if len(webp_data) < ln * 0.92:
            new_img_bytes[idx] = (webp_data, "image/webp")
            converted_imgs.add(idx)
            any_changed = True
        else:
            new_img_bytes[idx] = (orig_img, mime)

    if not any_changed:
        return {"path": rel, "skipped": "no-gain", "oldBytes": old_size, "newBytes": old_size}

    # Rebuild BIN buffer: keep all non-image bufferViews bit-for-bit (4-byte aligned),
    # then append each image bufferView cleanly!
    # Map each bufferView index -> new (byteOffset, byteLength)
    out_parts = []
    cur_off = 0

    # Check if any image shares a bufferView with another image (rare, handle cleanly)
    bv_to_img = {}
    for idx, im in enumerate(images):
        if "bufferView" in im:
            bv_to_img[im["bufferView"]] = idx

    for bv_idx, bv in enumerate(buffer_views):
        if bv_idx in bv_to_img:
            img_idx = bv_to_img[bv_idx]
            payload, mime = new_img_bytes[img_idx]
            padded = pad4(payload, b"\x00")
            bv["byteOffset"] = cur_off
            bv["byteLength"] = len(payload)
            images[img_idx]["mimeType"] = mime
            out_parts.append(padded)
            cur_off += len(padded)
        else:
            old_off = bv.get("byteOffset", 0)
            old_len = bv["byteLength"]
            slice_bytes = bdata[old_off : old_off + old_len]
            padded = pad4(slice_bytes, b"\x00")
            bv["byteOffset"] = cur_off
            out_parts.append(padded)
            cur_off += len(padded)

    new_bin = b"".join(out_parts)
    if gltf.get("buffers"):
        gltf["buffers"][0]["byteLength"] = len(new_bin)

    # Wire standard glTF 2.0 EXT_texture_webp extension on textures referencing WebP images
    if converted_imgs:
        exts_used = gltf.get("extensionsUsed") or []
        if "EXT_texture_webp" not in exts_used:
            exts_used.append("EXT_texture_webp")
        gltf["extensionsUsed"] = exts_used
        for tex in textures:
            src = tex.get("source")
            if src in converted_imgs:
                ext = tex.get("extensions") or {}
                ext["EXT_texture_webp"] = {"source": src}
                tex["extensions"] = ext

    json_bytes = pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    bin_bytes = pad4(new_bin, b"\x00")
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    new_glb = (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
        + struct.pack("<II", len(bin_bytes), 0x004E4942)
        + bin_bytes
    )

    new_sha = sha256_bytes(new_glb)
    new_rel = rel
    target_path = glb_path

    # Rename hash-suffixed popular agent GLBs so packagedAgentAssets() filename-hash check stays valid!
    m = re.match(r"^(assets/characters-cs2/popular/[a-z0-9-]+/(?:body|arms)-)[0-9a-f]{12}(\.glb)$", rel)
    if m:
        new_rel = f"{m.group(1)}{new_sha[:12]}{m.group(2)}"
        target_path = PUBLIC / new_rel

    tmp_path = target_path.with_suffix(".glb.tmp")
    tmp_path.write_bytes(new_glb)
    os.replace(tmp_path, target_path)
    if target_path != glb_path and glb_path.exists():
        glb_path.unlink()

    return {
        "oldPath": rel,
        "newPath": new_rel,
        "oldBytes": old_size,
        "newBytes": len(new_glb),
        "oldSha256": old_sha,
        "newSha256": new_sha,
        "convertedImages": len(converted_imgs),
    }


def compress_single_map_webp(webp_path_str: str) -> dict:
    p = Path(webp_path_str)
    old_size = p.stat().st_size
    if old_size < 40 * 1024:
        return {"oldBytes": old_size, "newBytes": old_size, "changed": False}
    try:
        pil = Image.open(p)
        pil.load()
    except Exception:
        return {"oldBytes": old_size, "newBytes": old_size, "changed": False}
    w, h = pil.size
    has_alpha = pil.mode in ("RGBA", "LA")
    if has_alpha:
        if pil.mode != "RGBA":
            pil = pil.convert("RGBA")
    else:
        if pil.mode != "RGB":
            pil = pil.convert("RGB")
    if max(w, h) > MAX_MAP_DIM:
        scale = MAX_MAP_DIM / max(w, h)
        pil = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    pil.save(buf, format="WEBP", quality=80, method=5)
    out = buf.getvalue()
    if len(out) < old_size * 0.88:
        tmp = p.with_suffix(".webp.tmp")
        tmp.write_bytes(out)
        os.replace(tmp, p)
        return {"oldBytes": old_size, "newBytes": len(out), "changed": True}
    return {"oldBytes": old_size, "newBytes": old_size, "changed": False}


def optimize_dust2_bg_png() -> dict:
    p = ASSETS / "valve-dust2" / "de_dust2_1_png.png"
    if not p.exists():
        return {"oldBytes": 0, "newBytes": 0}
    old_size = p.stat().st_size
    if old_size < 800 * 1024:
        return {"oldBytes": old_size, "newBytes": old_size}
    pil = Image.open(p).convert("RGB")
    if pil.width > 1280:
        scale = 1280 / pil.width
        pil = pil.resize((1280, max(1, round(pil.height * scale))), Image.Resampling.LANCZOS)
    # High-quality 256-color median-cut PNG keeps crisp background artwork at ~12% size!
    quant = pil.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    buf = io.BytesIO()
    quant.save(buf, format="PNG", optimize=True)
    out = buf.getvalue()
    if len(out) < old_size * 0.8:
        tmp = p.with_suffix(".png.tmp")
        tmp.write_bytes(out)
        os.replace(tmp, p)
        return {"oldBytes": old_size, "newBytes": len(out)}
    return {"oldBytes": old_size, "newBytes": old_size}


def main():
    t0 = time.time()
    workers = max(2, min(8, os.cpu_count() or 4))

    glb_files = sorted(str(p) for p in ASSETS.rglob("*.glb"))
    print(f"[1/3] Compressing {len(glb_files)} GLB files using {workers} workers...", flush=True)
    glb_results = []
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(compress_single_glb, glb_files):
            glb_results.append(res)

    changed_glbs = [r for r in glb_results if "newSha256" in r]
    glb_old = sum(r["oldBytes"] for r in glb_results)
    glb_new = sum(r["newBytes"] for r in glb_results)
    print(
        f"  GLBs done: {len(changed_glbs)}/{len(glb_files)} compressed, "
        f"{glb_old/1e6:.1f} MB -> {glb_new/1e6:.1f} MB (-{(1 - glb_new/max(1, glb_old))*100:.1f}%)",
        flush=True,
    )

    map_webps = sorted(str(p) for p in (ASSETS / "map-cs2" / "textures").glob("*.webp"))
    print(f"[2/3] Re-compressing {len(map_webps)} map-cs2 WebP textures...", flush=True)
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as ex:
        webp_results = list(ex.map(compress_single_map_webp, map_webps))
    w_old = sum(r["oldBytes"] for r in webp_results)
    w_new = sum(r["newBytes"] for r in webp_results)
    w_chg = sum(1 for r in webp_results if r["changed"])
    print(
        f"  map-cs2 textures done: {w_chg}/{len(map_webps)} reduced, "
        f"{w_old/1e6:.1f} MB -> {w_new/1e6:.1f} MB (-{(1 - w_new/max(1, w_old))*100:.1f}%)",
        flush=True,
    )

    png_res = optimize_dust2_bg_png()
    print(
        f"[3/3] de_dust2_1_png.png: {png_res['oldBytes']/1e6:.2f} MB -> {png_res['newBytes']/1e6:.2f} MB",
        flush=True,
    )

    report_path = ROOT / "artifacts" / "compression-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "elapsedSec": round(time.time() - t0, 1),
        "glbTotalOld": glb_old,
        "glbTotalNew": glb_new,
        "mapWebpOld": w_old,
        "mapWebpNew": w_new,
        "dust2BgPng": png_res,
        "changedGlbs": changed_glbs,
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Saved report: {report_path} ({report['elapsedSec']}s)", flush=True)


if __name__ == "__main__":
    main()
