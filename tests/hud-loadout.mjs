import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {loadoutRows} from '../client/hud-loadout.js';
import {knifeIconId, knifeDisplayName, weaponIconId} from '../client/ui-icons.js';
import {SKINS} from '../shared/skins.js';

test('HUD follows authoritative inventory after purchase, pickup, drop and switch',()=>{
 const p={inventory:['awp','usp','knife'],weapon:'awp',utilityCounts:{flashbang:2,smokegrenade:1},defuseKit:true};
 let rows=loadoutRows(p);assert.deepEqual(rows.map(r=>r.id),['awp','usp','knife','flashbang','smokegrenade','defusekit']);
 assert.deepEqual(rows.filter(r=>r.active).map(r=>r.id),['awp']);assert.equal(rows.find(r=>r.id==='flashbang').count,2);
 p.inventory=['m4a1','usp','knife'];p.weapon='m4a1';rows=loadoutRows(p);assert.equal(rows.some(r=>r.id==='awp'),false);assert.equal(rows[0].active,true);
 p.inventory=['usp','knife'];p.weapon='knife';assert.equal(loadoutRows(p).some(r=>r.slot===1),false);
});
test('C4, kit and depleted utility disappear; unknown IDs never create phantom guns',()=>{
 const p={inventory:['garbage','knife','c4'],weapon:'c4',hasBomb:true,utilityCounts:{flashbang:0,molotov:-2}};
 assert.deepEqual(loadoutRows(p).map(r=>r.id),['knife','c4']);assert.equal(loadoutRows(p).at(-1).active,true);
 p.hasBomb=false;assert.deepEqual(loadoutRows(p).map(r=>r.id),['knife']);assert.deepEqual(loadoutRows({}),[]);
});
test('knife HUD icon and name always match the equipped knife skin (never Karambit for default knives)',()=>{
 const ctDefault = loadoutRows({inventory:['usp','knife'],weapon:'usp',team:'CT'},{knife:'default-ct-vanilla'});
 const ctKnife = ctDefault.find(r=>r.id==='knife');
 assert.equal(ctKnife.iconId,'knifeDefaultCt');
 assert.equal(ctKnife.name,'反恐精英匕首');

 const tDefault = loadoutRows({inventory:['pistol','knife'],weapon:'knife',skinId:'default-t-vanilla',team:'T'});
 const tKnife = tDefault.find(r=>r.id==='knife');
 assert.equal(tKnife.iconId,'knifeDefaultT');
 assert.equal(tKnife.name,'恐怖分子匕首');

 assert.equal(weaponIconId('knife','karambit-sapphire','CT'),'knifeKarambit');
 assert.equal(knifeDisplayName('karambit-sapphire','CT'),'爪子刀');
 assert.equal(weaponIconId('knife','m9-vanilla','CT'),'knifeM9');
 assert.equal(weaponIconId('knife','butterfly-vanilla','CT'),'knifeButterfly');
 assert.equal(weaponIconId('knife','skeleton-vanilla','CT'),'knifeSkeleton');
 assert.equal(weaponIconId('knife','push-vanilla','CT'),'knifePush');

 // Every single knife skin in SKINS must resolve to a real existing SVG in both client/original-hud and public/assets/ui-cs2
 for (const k of SKINS.filter(s=>s.weapon==='knife')) {
  const icon = knifeIconId(k.id,'CT');
  assert.ok(fs.existsSync(path.resolve('client/original-hud', icon + '.svg')), `Missing client SVG for ${k.id}: ${icon}.svg`);
  assert.ok(fs.existsSync(path.resolve('public/assets/ui-cs2', icon + '.svg')), `Missing public SVG for ${k.id}: ${icon}.svg`);
 }
});
