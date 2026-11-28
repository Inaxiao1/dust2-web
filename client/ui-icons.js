// Shapes are extracted from Valve's Panorama resources plus exact knife-family silhouettes.
import {imageAssetURL} from './image-asset-url.js';
import {originalIcons} from './original-hud/icons.js';
import {getSkin} from '../shared/skins.js';

const KNIFE_FAMILY_TO_ICON = Object.freeze({
  default_ct: 'knifeDefaultCt',
  default_t: 'knifeDefaultT',
  karambit: 'knifeKarambit',
  m9: 'knifeM9',
  butterfly: 'knifeButterfly',
  bayonet: 'knifeBayonet',
  bowie: 'knifeBowie',
  canis: 'knifeCanis',
  cord: 'knifeCord',
  css: 'knifeCss',
  falchion: 'knifeFalchion',
  flip: 'knifeFlip',
  gut: 'knifeGut',
  kukri: 'knifeKukri',
  navaja: 'knifeNavaja',
  outdoor: 'knifeOutdoor',
  push: 'knifePush',
  skeleton: 'knifeSkeleton',
  stiletto: 'knifeStiletto',
  tactical: 'knifeTactical',
  talon: 'knifeTalon',
  ursus: 'knifeUrsus',
});

export function knifeIconId(skinId, team = 'CT') {
  const skin = getSkin(skinId);
  if (skin?.weapon === 'knife') {
    if (skin.animationFamily && KNIFE_FAMILY_TO_ICON[skin.animationFamily]) {
      return KNIFE_FAMILY_TO_ICON[skin.animationFamily];
    }
    if (skin.id.startsWith('karambit-')) return 'knifeKarambit';
    if (skin.id.startsWith('m9-')) return 'knifeM9';
    if (skin.id.startsWith('butterfly-')) return 'knifeButterfly';
    if (skin.id.startsWith('default-t')) return 'knifeDefaultT';
    if (skin.id.startsWith('default-ct')) return 'knifeDefaultCt';
    const prefix = skin.id.split('-')[0];
    if (KNIFE_FAMILY_TO_ICON[prefix]) return KNIFE_FAMILY_TO_ICON[prefix];
  }
  return team === 'T' ? 'knifeDefaultT' : 'knifeDefaultCt';
}

export function knifeDisplayName(skinId, team = 'CT') {
  const skin = getSkin(skinId);
  if (skin?.weapon === 'knife') {
    if (skin.id.startsWith('karambit-') && !skin.name.startsWith('爪子刀')) return '爪子刀';
    return skin.name.split(' · ')[0];
  }
  return team === 'T' ? '恐怖分子匕首' : '反恐精英匕首';
}

export function weaponIconId(weaponId, skinId = null, team = 'CT') {
  if (weaponId === 'knife') return knifeIconId(skinId, team);
  return weaponId;
}

const icons=new Set(['hkp2000','cz75a','revolver','aug','famas','g3sg1','mp5sd','p90','ump45','m249','negev','ak47','m4a4','m4a1','awp','pistol','usp','elite','p250','fiveseven','deagle','nova','mag7','mp9','mp7','bizon','scar20','ssg08','tec9','xm1014','sawedoff','mac10','galilar','sg553','knife','knifeDefaultCt','knifeDefaultT','knifeKarambit','knifeM9','knifeButterfly','knifeBayonet','knifeBowie','knifeCanis','knifeCord','knifeCss','knifeFalchion','knifeFlip','knifeGut','knifeKukri','knifeNavaja','knifeOutdoor','knifePush','knifeSkeleton','knifeStiletto','knifeTactical','knifeTalon','knifeUrsus','molotov','incgrenade','decoy','hegrenade','flashbang','smokegrenade','armor','helmet','defusekit','c4','world','headshot','wallbang','smoke','blind','noscope','airborne','assist','death','health','CT','T','kill','killHeadshot','timer']);
export const uiIconUrl=id=>originalIcons[id]||imageAssetURL(`assets/ui-cs2/${icons.has(id)?id:'world'}.svg`);
export function uiIcon(id,alt='',className=''){
  const image=document.createElement('img');image.className=`cs2-icon ${className}`.trim();image.src=uiIconUrl(id);image.alt=alt;image.draggable=false;
  if(alt)image.title=alt;else image.setAttribute('aria-hidden','true');return image;
}
