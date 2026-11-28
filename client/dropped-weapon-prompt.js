import * as THREE from 'three';
import {clone} from 'three/addons/utils/SkeletonUtils.js';
import {getSkin} from '../shared/skins.js';
import {getWeapon} from '../shared/weapons.js';
import {loadedSkin} from './skin-assets.js';
import {disposeInstanceSkeletons} from './resource-lifecycle.js';
import {uiIconUrl, weaponIconId} from './ui-icons.js';
import './dropped-weapon-prompt.css';

const PREVIEW_WIDTH = 256;
const PREVIEW_HEIGHT = 144;

export class DroppedWeaponPrompt {
  constructor(renderer, weaponScene) {
    this.renderer = renderer;
    this.weaponScene = weaponScene;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera();
    const light = new THREE.DirectionalLight(0xffeed4, 3.1);
    light.position.set(-3, 5, 6);
    this.scene.add(light, new THREE.HemisphereLight(0xd9efff, 0xa28b70, 2.15));

    this.element = document.createElement('div');
    this.element.id = 'pickup-prompt';
    this.element.hidden = true;
    this.element.innerHTML = `
      <div class="pickup-preview" aria-hidden="true">
        <img alt="">
        <canvas width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" hidden></canvas>
      </div>
      <div class="pickup-details">
        <b class="pickup-weapon-name"></b>
        <span class="pickup-skin"></span>
        <span class="pickup-action"><kbd></kbd>拾取</span>
      </div>
      <dl class="pickup-ammo">
        <div><dt>弹匣</dt><dd class="pickup-magazine"></dd></div>
        <div><dt>备弹</dt><dd class="pickup-reserve"></dd></div>
      </dl>`;
    this.canvas = this.element.querySelector('canvas');
    this.context = this.canvas.getContext('2d');
    this.fallback = this.element.querySelector('img');
    this.name = this.element.querySelector('.pickup-weapon-name');
    this.skin = this.element.querySelector('.pickup-skin');
    this.key = this.element.querySelector('kbd');
    this.magazine = this.element.querySelector('.pickup-magazine');
    this.reserve = this.element.querySelector('.pickup-reserve');
    document.body.append(this.element);
  }

  update(drop, binding) {
    this.element.hidden = !drop;
    if (!drop) return;

    const signature = [drop.weaponId, drop.skinId, drop.ammo, drop.reserve, binding].join('|');
    if (this.signature !== signature) {
      this.signature = signature;
      this.name.textContent = getWeapon(drop.weaponId).name;
      this.skin.textContent = getSkin(drop.skinId)?.name || '';
      this.skin.hidden = !this.skin.textContent;
      this.key.textContent = binding;
      this.key.hidden = !binding;
      this.magazine.textContent = drop.ammo ?? '—';
      this.reserve.textContent = drop.reserve ?? '—';
      this.fallback.src = uiIconUrl(weaponIconId(drop.weaponId, drop.skinId));
    }

    if (this.context && drop.skinId && this.renderedSkin !== drop.skinId) {
      const source = loadedSkin(drop.skinId);
      if (source) {
        this.renderModel(source.scene);
        this.renderedSkin = drop.skinId;
      }
    }

    const hasPreview = Boolean(drop.skinId && this.renderedSkin === drop.skinId);
    this.canvas.hidden = !hasPreview;
    this.fallback.hidden = hasPreview;
  }

  renderModel(source) {
    // Draw one thumbnail into a small target shared with the game's renderer.
    // The HUD keeps the canvas pixels while the player stays near the drop.
    this.target ??= new THREE.WebGLRenderTarget(PREVIEW_WIDTH, PREVIEW_HEIGHT, {
      colorSpace: THREE.SRGBColorSpace,
      samples: 4,
    });
    this.pixels ??= new Uint8Array(PREVIEW_WIDTH * PREVIEW_HEIGHT * 4);
    this.image ??= this.context.createImageData(PREVIEW_WIDTH, PREVIEW_HEIGHT);

    const model = clone(source);
    model.rotation.y -= Math.PI / 2 - 0.24;
    model.updateMatrixWorld(true);
    model.traverse(node => {
      if (!node.isSkinnedMesh) return;
      node.skeleton.update();
      node.computeBoundingBox();
    });
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    model.position.sub(bounds.getCenter(new THREE.Vector3()));

    const aspect = PREVIEW_WIDTH / PREVIEW_HEIGHT;
    const halfHeight = Math.max(size.x / aspect, size.y) * 0.60;
    const camera = this.camera;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.near = 0.01;
    camera.far = size.z + 2;
    camera.position.z = size.z * 0.5 + 1;
    camera.updateProjectionMatrix();

    const {renderer} = this;
    const previousTarget = renderer.getRenderTarget();
    const previousColor = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    this.scene.environment = this.weaponScene.environment;
    this.scene.environmentIntensity = this.weaponScene.environmentIntensity;
    this.scene.add(model);
    try {
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0, 0);
      renderer.autoClear = true;
      renderer.render(this.scene, camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT, this.pixels);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousColor, previousAlpha);
      renderer.autoClear = previousAutoClear;
      model.removeFromParent();
      this.scene.environment = null;
      disposeInstanceSkeletons(model);
    }

    const stride = PREVIEW_WIDTH * 4;
    for (let row = 0; row < PREVIEW_HEIGHT; row++) {
      const start = (PREVIEW_HEIGHT - 1 - row) * stride;
      this.image.data.set(this.pixels.subarray(start, start + stride), row * stride);
    }
    this.context.putImageData(this.image, 0, 0);
  }

  clear() {
    this.element.hidden = true;
    this.renderedSkin = null;
    this.target?.dispose();
    this.target = null;
  }

  dispose() {
    this.clear();
    this.element.remove();
  }
}
