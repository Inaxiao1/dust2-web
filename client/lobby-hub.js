import interfaceCss from './interface.css?inline';
import controlsCss from './controls.css?inline';
import agentsCss from './agents.css?inline';
import loadoutCss from './loadout-menu.css?inline';
import skinsCss from './skins.css?inline';
import progressionCss from './progression.css?inline';
import { preferences } from './persistence.js';
import { getSharedToyProgress } from './toy-cloud-progress.js';
import { initDownloadOrigin } from './download-origin.js';
import { DEFAULT_CROSSHAIR, normalizeCrosshair } from '../shared/cs2-settings.js';
import { normalizeVideo, viewportSize } from '../shared/video-settings.js';
import { normalizeBotDifficulty } from '../shared/bot-difficulty.js';
import { normalizeClarity, normalizeFlatScale } from '../shared/render-quality.js';
import { GameControls } from './controls.js';
import { Crosshair } from './crosshair.js';
import { mountSettings } from './settings-ui.js';
import { mountBotSettings } from './bot-settings.js';
import { mountFrameSettings } from './frame-settings.js';
import { GameAudio } from './audio.js';
import { MatchAudio, mountMusicSettings } from './match-audio.js';
import { AgentMenu } from './agent-menu.js';
import { LoadoutMenu } from './loadout-menu.js';
import { SkinMenu } from './skin-menu.js';
import { ProgressionMenu } from './progression-menu.js';
import { upgradeAllSelects } from './tactical-select.js';
import { getStoredVisualStyle, setStoredVisualStyle } from './arena-look-presets.js';

let hubPromise = null;

function createHub() {
  if (hubPromise) return hubPromise;
  hubPromise = (async () => {
    if (!document.getElementById('lobbyHubInlineStyles')) {
      const style = document.createElement('style');
      style.id = 'lobbyHubInlineStyles';
      style.textContent = [interfaceCss, controlsCss, agentsCss, loadoutCss, skinsCss, progressionCss].join('\n');
      document.head.append(style);
    }
    try {
      await initDownloadOrigin({
        configURL: new URL('download-config.json', document.baseURI),
        pageURL: document.baseURI,
      });
    } catch {
      // Local packaged assets still resolve relative to /perf/.
    }

    const storedSettings = preferences.readJSON('dust2.cs-settings.v1');
    const videoDefaults = { aspect: '4:3', display: 'stretch' };
    let video = normalizeVideo({ ...videoDefaults, ...storedSettings });
    let sensitivity = Math.max(0.05, Math.min(100, Number(storedSettings.sensitivity) || 1));
    let zoomSensitivity = Math.max(0.05, Math.min(10, Number(storedSettings.zoomSensitivity) || 1));
    let invertY = Boolean(storedSettings.invertY);
    let crosshairSettings = normalizeCrosshair(storedSettings.crosshair || DEFAULT_CROSSHAIR);
    let quality = preferences.getItem('dust2.quality.v2') === 'high' ? 'high' : 'low';
    let visualStyle = getStoredVisualStyle();
    let brightness = Math.max(60, Math.min(160, Number(preferences.getItem('dust2.brightness')) || 100));
    let radarRotate = storedSettings.radarRotate !== false;
    let mobileClarity = normalizeClarity(storedSettings.mobileClarity);
    let flatRenderScale = normalizeFlatScale(storedSettings.flatRenderScale);
    let preferredBotDifficulty = normalizeBotDifficulty(storedSettings.botDifficulty);
    let volume = Number(preferences.getItem('dust2.volume') ?? 0.6);

    function persistSettings() {
      preferences.setItem(
        'dust2.cs-settings.v1',
        JSON.stringify({
          ...preferences.readJSON('dust2.cs-settings.v1'),
          sensitivity,
          zoomSensitivity,
          invertY,
          crosshair: crosshairSettings,
          quality,
          brightness,
          mobileClarity,
          flatRenderScale,
          radarRotate,
          botDifficulty: preferredBotDifficulty,
          ...video,
        }),
      );
    }

    const audio = new GameAudio();
    audio.setVolume(volume);
    const matchAudio = new MatchAudio(audio);

    const dummyCrosshairHost = document.createElement('div');
    dummyCrosshairHost.hidden = true;
    const crosshair = new Crosshair(dummyCrosshairHost, {
      settings: crosshairSettings,
      getViewport: () => viewportSize(innerWidth, innerHeight, video),
    });

    const controls = new GameControls({
      target: window,
      storage: preferences,
      enabled: () => false,
      onAction: () => {},
    });

    const settingsUI = mountSettings({
      controls,
      crosshair,
      videoDefaults,
      isInMatch: () => false,
      getSettings: () => ({
        sensitivity,
        zoomSensitivity,
        invertY,
        crosshair: crosshairSettings,
        quality,
        visualStyle,
        brightness,
        mobileClarity,
        flatRenderScale,
        radarRotate,
        botDifficulty: preferredBotDifficulty,
        ...video,
      }),
      onSettings: (values) => {
        if (values.aspect !== undefined || values.display !== undefined) video = normalizeVideo({ ...video, ...values });
        if (values.radarRotate !== undefined) radarRotate = values.radarRotate;
        if (values.flatRenderScale !== undefined) flatRenderScale = normalizeFlatScale(values.flatRenderScale);
        if (values.mobileClarity !== undefined) mobileClarity = normalizeClarity(values.mobileClarity);
        if (values.sensitivity !== undefined) sensitivity = values.sensitivity;
        if (values.zoomSensitivity !== undefined) zoomSensitivity = values.zoomSensitivity;
        if (values.invertY !== undefined) invertY = Boolean(values.invertY);
        if (values.crosshair) crosshairSettings = values.crosshair;
        if (values.visualStyle !== undefined) {
          visualStyle = setStoredVisualStyle(values.visualStyle);
        }
        if (values.quality !== undefined) {
          quality = values.quality === 'high' ? 'high' : 'low';
          preferences.setItem('dust2.quality.v2', quality);
        }
        if (values.brightness !== undefined) {
          brightness = Math.max(60, Math.min(160, Number(values.brightness) || 100));
          preferences.setItem('dust2.brightness', String(brightness));
        }
        persistSettings();
      },
    });

    mountBotSettings(settingsUI, {
      getState: () => ({ connected: false, host: true, value: preferredBotDifficulty }),
      onChange: (value) => {
        preferredBotDifficulty = normalizeBotDifficulty(value);
        persistSettings();
      },
    });

    mountMusicSettings(settingsUI, matchAudio, audio, {
      getVolume: () => volume,
      setVolume: (value) => {
        volume = Math.max(0, Math.min(1, Number(value) || 0));
        audio.setVolume(volume);
        preferences.setItem('dust2.volume', String(volume));
      },
    });

    mountFrameSettings(settingsUI);

    upgradeAllSelects(settingsUI.element, {
      'cs-aspect': { variant: 'pills' },
      'cs-display': { variant: 'pills' },
      'cs-radar-direction': { variant: 'pills' },
      'cs-quality': { variant: 'cards' },
      'cs-flat-render-scale': { variant: 'pills' },
      'cs-mobile-clarity': { variant: 'pills' },
      'frame-limit': { variant: 'pills' },
      'bot-difficulty': { variant: 'cards' },
      'music-kit': { variant: 'grid' },
      'music-preview-cue': { variant: 'grid', compact: true },
    });

    const progressStore = getSharedToyProgress(globalThis[Symbol.for('cs2.toyIdentity')] || null);
    void progressStore.init();

    const progression = new ProgressionMenu({
      progressStore,
      onOpenSkins: () => skins.open(),
      onOpenAgents: () => agents.open(),
    });
    const skins = new SkinMenu({
      progressStore,
      onEquip: async () => {},
      onLoadout: () => armory.open(),
      onProgression: () => progression.open(),
    });
    const armory = new LoadoutMenu({
      progressStore,
      getSkins: () => skins.loadout,
      onApply: async (next) => next,
      openSkins: () => skins.open(),
      canEdit: () => true,
    });
    const agents = new AgentMenu({
      progressStore,
      onProgression: () => progression.open(),
      onEquip: async (agent, next) => {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('cs2-agent-updated', { detail: { agent, loadout: next } }));
        }, 0);
      },
    });

    // Click backdrop outside modal card to close cleanly
    for (const [el, closeFn] of [
      [progression.element, () => progression.close()],
      [agents.element, () => agents.close()],
      [armory.element, () => armory.close()],
      [skins.element, () => skins.close()],
      [settingsUI.element, () => settingsUI.element.querySelector('#close-settings')?.click()],
    ]) {
      el.addEventListener('click', (event) => {
        if (event.target === el) closeFn();
      });
    }

    function closeAll() {
      progression.close();
      agents.close();
      armory.close();
      skins.close();
      if (!settingsUI.element.hidden) settingsUI.element.querySelector('#close-settings')?.click();
    }

    return {
      progressStore,
      open(panel) {
        closeAll();
        if (panel === 'progression') progression.open();
        else if (panel === 'agents') agents.open();
        else if (panel === 'loadout') armory.open();
        else if (panel === 'skins') skins.open();
        else if (panel === 'settings') settingsUI.open();
        else if (panel === 'music') {
          settingsUI.open('audio');
        }
      },
    };
  })();
  return hubPromise;
}

export async function openHubPanel(panel) {
  const hub = await createHub();
  hub.open(panel);
}

export async function initHubProgression() {
  const hub = await createHub();
  return hub.progressStore;
}

globalThis.__CS2_LOBBY_HUB__ = { openHubPanel, initHubProgression };
