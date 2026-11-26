import { For, createMemo } from 'solid-js';
import { itemsForTeam, type ShopItem } from '../catalog/weapons.ts';
import type { TeamSide } from '../net/protocol.ts';

const CATEGORIES: Array<{ id: ShopItem['category']; label: string }> = [
  { id: 'rifles', label: '步枪' },
  { id: 'mid', label: '微型冲锋枪 / 霰弹' },
  { id: 'pistols', label: '手枪' },
  { id: 'equipment', label: '护甲 / 拆弹器' },
  { id: 'grenades', label: '投掷物' },
];

export function BuyMenu(props: {
  team: TeamSide;
  money: number;
  currentWeapon: string;
  onBuy: (weaponId: string) => void;
  onRefund: (weaponId: string) => void;
  onDrop: () => void;
  onClose: () => void;
}) {
  const items = createMemo(() => itemsForTeam(props.team));

  return (
    <div class="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="buy-panel">
        <div class="row" style="justify-content: space-between; align-items: center;">
          <div>
            <strong style="color: #f3d995; font-size: 16px;">战术商店 ({props.team})</strong>
            <span style="margin-left: 12px; color: #82e3b3; font-weight: 700;">可用金钱: ${props.money}</span>
          </div>
          <div class="row">
            <button class="secondary" onClick={() => props.onRefund(props.currentWeapon)}>退还当前武器</button>
            <button class="secondary" onClick={() => props.onDrop()}>丢弃主武器 (G)</button>
            <button class="secondary" onClick={() => props.onClose()}>关闭 (B)</button>
          </div>
        </div>

        <div class="buy-columns">
          <For each={CATEGORIES}>
            {cat => (
              <div class="buy-column">
                <h3>{cat.label}</h3>
                <For each={items().filter(item => item.category === cat.id)}>
                  {item => (
                    <button
                      class="buy-item"
                      disabled={props.money < item.price}
                      onClick={() => props.onBuy(item.id)}
                    >
                      <span>{item.name}</span>
                      <span class="price">${item.price}</span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
