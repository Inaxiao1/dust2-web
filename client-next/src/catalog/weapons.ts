import type { TeamSide } from '../net/protocol.ts';

export interface ShopItem {
  id: string;
  name: string;
  price: number;
  category: 'rifles' | 'mid' | 'pistols' | 'equipment' | 'grenades';
  teams: readonly TeamSide[];
}

export const SHOP_ITEMS: readonly ShopItem[] = [
  // Rifles
  { id: 'ak47', name: 'AK-47', price: 2700, category: 'rifles', teams: ['T'] },
  { id: 'galilar', name: '加利尔 AR', price: 1800, category: 'rifles', teams: ['T'] },
  { id: 'sg553', name: 'SG 553', price: 3000, category: 'rifles', teams: ['T'] },
  { id: 'm4a1', name: 'M4A1-S', price: 2900, category: 'rifles', teams: ['CT'] },
  { id: 'm4a4', name: 'M4A4', price: 2900, category: 'rifles', teams: ['CT'] },
  { id: 'famas', name: 'FAMAS', price: 1950, category: 'rifles', teams: ['CT'] },
  { id: 'aug', name: 'AUG', price: 3300, category: 'rifles', teams: ['CT'] },
  { id: 'ssg08', name: 'SSG 08', price: 1700, category: 'rifles', teams: ['CT', 'T'] },
  { id: 'awp', name: 'AWP', price: 4750, category: 'rifles', teams: ['CT', 'T'] },

  // Mid-tier (SMG / Shotgun)
  { id: 'mac10', name: 'MAC-10', price: 1050, category: 'mid', teams: ['T'] },
  { id: 'mp9', name: 'MP9', price: 1250, category: 'mid', teams: ['CT'] },
  { id: 'ump45', name: 'UMP-45', price: 1200, category: 'mid', teams: ['CT', 'T'] },
  { id: 'mp7', name: 'MP7', price: 1400, category: 'mid', teams: ['CT', 'T'] },
  { id: 'p90', name: 'P90', price: 2350, category: 'mid', teams: ['CT', 'T'] },
  { id: 'xm1014', name: 'XM1014', price: 2000, category: 'mid', teams: ['CT', 'T'] },

  // Pistols
  { id: 'p250', name: 'P250', price: 300, category: 'pistols', teams: ['CT', 'T'] },
  { id: 'elite', name: '双持贝瑞塔', price: 300, category: 'pistols', teams: ['CT', 'T'] },
  { id: 'fiveseven', name: 'FN57', price: 500, category: 'pistols', teams: ['CT'] },
  { id: 'tec9', name: 'Tec-9', price: 500, category: 'pistols', teams: ['T'] },
  { id: 'deagle', name: '沙漠之鹰', price: 700, category: 'pistols', teams: ['CT', 'T'] },

  // Equipment
  { id: 'armor', name: '防弹背心', price: 650, category: 'equipment', teams: ['CT', 'T'] },
  { id: 'helmet', name: '背心 + 头盔', price: 1000, category: 'equipment', teams: ['CT', 'T'] },
  { id: 'defusekit', name: '拆弹工具', price: 400, category: 'equipment', teams: ['CT'] },

  // Grenades
  { id: 'flashbang', name: '闪光弹', price: 200, category: 'grenades', teams: ['CT', 'T'] },
  { id: 'smokegrenade', name: '烟雾弹', price: 300, category: 'grenades', teams: ['CT', 'T'] },
  { id: 'hegrenade', name: '高爆手雷', price: 300, category: 'grenades', teams: ['CT', 'T'] },
  { id: 'molotov', name: '燃烧瓶', price: 400, category: 'grenades', teams: ['T'] },
  { id: 'incgrenade', name: '燃烧弹', price: 500, category: 'grenades', teams: ['CT'] },
];

export function itemsForTeam(team: TeamSide): ShopItem[] {
  return SHOP_ITEMS.filter(item => item.teams.includes(team));
}
