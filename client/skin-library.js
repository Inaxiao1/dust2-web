import {SKINS} from '../shared/skins.js';
import {getWeapon} from '../shared/weapons.js';
import {getSkinUnlockRequirement, isSkinUnlocked} from '../shared/progression.js';

export function filterSkins({weapon='all',category='all',query='',availability='all',downloaded=new Set(),loadout={},progress=null}={}){
 const search=String(query).trim().toLocaleLowerCase();
 return SKINS.filter(s=>{
  if(weapon!=='all'&&s.weapon!==weapon)return false;
  if(category!=='all'&&getWeapon(s.weapon).category!==category)return false;
  if(search&&!`${s.name} ${s.englishName||''} ${getWeapon(s.weapon).name}`.toLocaleLowerCase().includes(search))return false;
  if(availability==='all')return true;
  if(availability==='vanilla')return s.condition==='Vanilla';
  if(availability==='popular')return s.collection==='popular';
  if(availability==='equipped')return loadout[s.weapon]===s.id;
  if(availability==='saved')return downloaded.has(s.id);
  if(availability==='unlocked')return isSkinUnlocked(s.id,progress);
  if(availability==='growth')return getSkinUnlockRequirement(s.id)?.type==='growth';
  if(availability==='toy_follow')return getSkinUnlockRequirement(s.id)?.type==='toy_follow';
  if(availability==='toy_triple')return getSkinUnlockRequirement(s.id)?.type==='toy_triple';
  return true;
 });
}
