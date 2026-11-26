import { Show, onCleanup, onMount } from 'solid-js';
import { createMatchStore } from '../state/match-store.ts';
import { Hud } from './Hud.tsx';
import { Lobby } from './Lobby.tsx';

export function App() {
  const store = createMatchStore();

  onMount(() => {
    void store.init();
    const timer = setInterval(() => {
      if (store.view() === 'lobby') {
        void store.refreshLobby();
      }
    }, 5000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <Show when={store.view() === 'match'} fallback={<Lobby store={store} />}>
      <Hud store={store} />
    </Show>
  );
}
