import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {applyPrivateCollisionExclusions} from '../../shared/private-map-collision.js';
import {decodePackedPhysics} from '../../client/compact-map-codec.js';
const sha=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');

/** Read raw file if present, else transparently decompress .br / .gz for slim server deployments. */
export function readFileOrCompressed(filePath) {
 if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
 if (fs.existsSync(filePath + '.br')) return zlib.brotliDecompressSync(fs.readFileSync(filePath + '.br'));
 if (fs.existsSync(filePath + '.gz')) return zlib.gunzipSync(fs.readFileSync(filePath + '.gz'));
 return fs.readFileSync(filePath);
}

/** Load raw physics.f32 or decode bit-exact lossless PVX1 physics.vidx(.br/.gz) on slim servers. */
function readPhysicsF32(compiled) {
 const rawPath = path.join(compiled, 'physics.f32');
 if (fs.existsSync(rawPath)) return fs.readFileSync(rawPath);
 const vidxPath = path.join(compiled, 'physics.vidx');
 if (fs.existsSync(vidxPath) || fs.existsSync(vidxPath + '.br') || fs.existsSync(vidxPath + '.gz')) {
  const packed = readFileOrCompressed(vidxPath);
  return Buffer.from(decodePackedPhysics(packed));
 }
 return readFileOrCompressed(rawPath);
}

/** Only the hash-bound source entity policy may remove collision groups.
 * A stale/missing policy is an error, so a replay cannot silently use different
 * geometry than the navigation audit. Original archives are never rewritten. */
export function loadPrivatePhysics(directory,channel=1) {
 if(![1,2,4].includes(channel))throw new Error('Private physics channel must be player, bullet, or grenade');
 const compiled=path.join(directory,'compiled'),bytes=readPhysicsF32(compiled);
 const originalMask=readFileOrCompressed(path.join(compiled,'physics-mask.u8'));
 const policyBytes=readFileOrCompressed(path.join(directory,'entity-collision-policy.json'));
 const policy=JSON.parse(policyBytes);
 const map=JSON.parse(readFileOrCompressed(path.join(compiled,'map.json')));
 const groupsBytes=readFileOrCompressed(path.join(compiled,'physics-groups.json')),groups=JSON.parse(groupsBytes);
 const physicsSha256=sha(bytes),maskSha256=sha(originalMask);
 if(policy.map!==map.id||policy.sourceSha256!==map.sourceSha256||policy.physicsSha256!==physicsSha256||policy.maskSha256!==maskSha256||policy.groupsSha256!==sha(groupsBytes))throw new Error('Private collision policy does not match immutable map geometry');
 const mask=Buffer.from(originalMask);
 applyPrivateCollisionExclusions(mask,groups,policy);
 const all=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
 if(all.length!==mask.length*9)throw new Error('Collision mask length does not match geometry');
 const positions=new Float32Array(mask.filter(m=>m&channel).length*9);
 const sourceTriangles=new Uint32Array(positions.length/9);
 for(let i=0,j=0;i<mask.length;i++)if(mask[i]&channel){positions.set(all.subarray(i*9,i*9+9),j);sourceTriangles[j/9]=i;j+=9;}
 return {positions,sourceTriangles,physicsSha256,maskSha256,policySha256:sha(policyBytes),excludedTriangles:policy.excludedTriangles};
}

/** Load all 3 channels (player=1, bullet=2, grenade=4) into a single shared position buffer + 1-byte mask (~67% less RAM & 3x faster BVH build). */
export function loadPrivatePhysicsShared(directory) {
 const compiled=path.join(directory,'compiled'),bytes=readPhysicsF32(compiled);
 const originalMask=readFileOrCompressed(path.join(compiled,'physics-mask.u8'));
 const policyBytes=readFileOrCompressed(path.join(directory,'entity-collision-policy.json'));
 const policy=JSON.parse(policyBytes);
 const map=JSON.parse(readFileOrCompressed(path.join(compiled,'map.json')));
 const groupsBytes=readFileOrCompressed(path.join(compiled,'physics-groups.json')),groups=JSON.parse(groupsBytes);
 const physicsSha256=sha(bytes),maskSha256=sha(originalMask);
 if(policy.map!==map.id||policy.sourceSha256!==map.sourceSha256||policy.physicsSha256!==physicsSha256||policy.maskSha256!==maskSha256||policy.groupsSha256!==sha(groupsBytes))throw new Error('Private collision policy does not match immutable map geometry');
 const mask=Buffer.from(originalMask);
 applyPrivateCollisionExclusions(mask,groups,policy);
 const all=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
 if(all.length!==mask.length*9)throw new Error('Collision mask length does not match geometry');
 let count=0;for(let i=0;i<mask.length;i++)if(mask[i]&7)count++;
 const positions=new Float32Array(count*9);
 const channelMask=new Uint8Array(count);
 const sourceTriangles=new Uint32Array(count);
 for(let i=0,t=0;i<mask.length;i++){
  const bits=mask[i]&7;if(!bits)continue;
  positions.set(all.subarray(i*9,i*9+9),t*9);
  channelMask[t]=bits;
  sourceTriangles[t]=i;
  t++;
 }
 return {positions,channelMask,sourceTriangles,physicsSha256,maskSha256,policySha256:sha(policyBytes),excludedTriangles:policy.excludedTriangles};
}
