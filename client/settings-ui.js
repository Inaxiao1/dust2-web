import {mobileDevice} from './device-profile.js';
import { DEFAULT_CROSSHAIR, normalizeCrosshair, decodeCrosshairCode } from '../shared/cs2-settings.js';
import { Crosshair } from './crosshair.js';

const SENS_PRESETS = [
  { value: 0.8, label: '0.80', tag: '低敏' },
  { value: 1.6, label: '1.60', tag: '经典' },
  { value: 3.2, label: '3.20', tag: '偏快' },
  { value: 6.0, label: '6.00', tag: '高敏' },
  { value: 12.0, label: '12.0', tag: '极速' },
  { value: 25.0, label: '25.0', tag: '触控板' },
];

const ZOOM_PRESETS = [
  { value: 0.82, label: '0.82', tag: 'CS 经典' },
  { value: 1.0, label: '1.00', tag: '默认 1:1' },
  { value: 1.25, label: '1.25', tag: '快速甩狙' },
];

const CROSSHAIR_PRESETS = [
  { id: 'donk', label: 'donk 默认', settings: DEFAULT_CROSSHAIR },
  { id: 'classic-green', label: '经典绿十字', settings: { ...DEFAULT_CROSSHAIR, style: 4, size: 2.5, thickness: 1, gap: -2, color: 5, red: 50, green: 255, blue: 80, outline: true, outlineThickness: 1, dot: false, tStyle: false } },
  { id: 'cyan-compact', label: '紧凑青色', settings: { ...DEFAULT_CROSSHAIR, style: 4, size: 1.5, thickness: 1, gap: -3, color: 5, red: 0, green: 230, blue: 255, outline: true, outlineThickness: 0.5, dot: false, tStyle: false } },
  { id: 'dot-precision', label: '单点精瞄', settings: { ...DEFAULT_CROSSHAIR, style: 4, size: 0, thickness: 1.5, gap: 0, color: 5, red: 255, green: 230, blue: 0, outline: true, outlineThickness: 1, dot: true, tStyle: false } },
  { id: 'white-contrast', label: '高对比纯白', settings: { ...DEFAULT_CROSSHAIR, style: 4, size: 2, thickness: 1, gap: -2, color: 5, red: 255, green: 255, blue: 255, outline: true, outlineThickness: 1, dot: false, tStyle: false } },
];

const COLOR_SWATCHES = [
  { label: '薄荷绿', rgb: [0, 255, 165] },
  { label: '经典绿', rgb: [50, 255, 50] },
  { label: '亮青', rgb: [0, 230, 255] },
  { label: '亮黄', rgb: [255, 230, 0] },
  { label: '纯白', rgb: [255, 255, 255] },
  { label: '猩红', rgb: [255, 59, 48] },
];

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setRangeFill(input) {
  if (!input) return;
  const min = Number(input.min || 0), max = Number(input.max || 100), val = Number(input.value || 0);
  const pct = max > min ? clampNumber(((val - min) / (max - min)) * 100, 0, 100) : 0;
  input.style.setProperty('--range-pct', pct.toFixed(1) + '%');
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(n => clampNumber(Math.round(n || 0), 0, 255).toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function readStoredDpi() {
  try {
    const n = Number(localStorage.getItem('dust2.mouse-dpi'));
    return [400, 800, 1600, 3200].includes(n) ? n : 800;
  } catch {
    return 800;
  }
}

export function mountSettings({controls,crosshair,getSettings,onSettings,videoDefaults={aspect:'16:9',display:'bars'}}) {
  const modal=document.createElement('div');
  modal.className='overlay settings-overlay';
  modal.id='settings-menu';
  modal.hidden=true;
  modal.innerHTML=`<section class="config-card">
    <header>
      <div><span class="eyebrow">PERSONAL SETTINGS</span><h2>游戏设置</h2></div>
      <button id="close-settings" type="button">完成 ×</button>
    </header>
    <div class="config-body">
      <nav class="config-tabs" aria-label="设置分类">
        <button data-tab="mouse" class="selected" type="button">鼠标</button>
        <button data-tab="video" type="button">画面</button>
        <button data-tab="crosshair" type="button">准星</button>
        <button data-tab="keys" type="button">键盘与按键</button>
      </nav>
      <div class="config-scroll">
        <section data-panel="mouse">
          <div class="settings-panel-head">
            <div><h3>鼠标与瞄准手感</h3><p>沿用 CS 原生 0.022° 灵敏度标尺，支持实时拖动调节与换算参考。</p></div>
            <button id="reset-mouse" class="btn-subtle" type="button">恢复默认鼠标</button>
          </div>
          <div class="settings-group">
            <div class="slider-control-head">
              <div><label class="control-title" for="cs-sensitivity">游戏内灵敏度</label><span class="control-sub">范围 0.05 – 100.00（滑块 0.10 – 50.00，高敏 / 触控板可按需调高）</span></div>
              <div class="stepper-box">
                <button type="button" class="step-btn" data-step-target="sensitivity" data-step-delta="-1" aria-label="降低游戏内灵敏度">−</button>
                <input id="cs-sensitivity" type="number" min="0.05" max="100" step="0.05">
                <button type="button" class="step-btn" data-step-target="sensitivity" data-step-delta="1" aria-label="提高游戏内灵敏度">+</button>
              </div>
            </div>
            <input id="cs-sensitivity-range" class="cs-range" aria-label="游戏内灵敏度滑块" type="range" min="0.1" max="50" step="0.05">
            <div class="preset-strip" data-presets="sensitivity">
              ${SENS_PRESETS.map(p=>`<button type="button" class="preset-chip" data-preset-key="sensitivity" data-preset-value="${p.value}"><b>${p.label}</b><span>${p.tag}</span></button>`).join('')}
            </div>
            <div class="telemetry-strip">
              <div class="telemetry-dpi">
                <span>参考鼠标 DPI</span>
                <div class="dpi-pills" role="group" aria-label="参考鼠标 DPI">
                  ${[400,800,1600,3200].map(d=>`<button type="button" class="dpi-pill" data-dpi="${d}">${d}</button>`).join('')}
                </div>
              </div>
              <div class="telemetry-metrics">
                <div><small>等效 eDPI</small><b id="mouse-edpi">800</b></div>
                <div><small>360° 转向距离</small><b id="mouse-cm360">52.0 cm</b></div>
                <div><small>手感区间</small><b id="mouse-feel-tag">主流竞技</b></div>
              </div>
            </div>
          </div>

          <div class="settings-group">
            <div class="slider-control-head">
              <div><label class="control-title" for="cs-zoom-sensitivity">开镜灵敏度倍率</label><span class="control-sub">AWP / 狙击镜缩放比例，范围 0.05 – 10.00</span></div>
              <div class="stepper-box">
                <button type="button" class="step-btn" data-step-target="zoomSensitivity" data-step-delta="-0.05" aria-label="降低开镜灵敏度倍率">−</button>
                <input id="cs-zoom-sensitivity" type="number" min="0.05" max="10" step="0.05">
                <button type="button" class="step-btn" data-step-target="zoomSensitivity" data-step-delta="0.05" aria-label="提高开镜灵敏度倍率">+</button>
              </div>
            </div>
            <input id="cs-zoom-sensitivity-range" class="cs-range" aria-label="开镜灵敏度滑块" type="range" min="0.1" max="5" step="0.05">
            <div class="preset-strip" data-presets="zoomSensitivity">
              ${ZOOM_PRESETS.map(p=>`<button type="button" class="preset-chip" data-preset-key="zoomSensitivity" data-preset-value="${p.value}"><b>${p.label}</b><span>${p.tag}</span></button>`).join('')}
            </div>
          </div>

          <div class="settings-group">
            <label class="config-row">
              <span><strong>反转鼠标 Y 轴</strong><small>向上移动鼠标时视角向下俯看（飞行摇杆习惯）</small></span>
              <input id="cs-invert-y" type="checkbox">
            </label>
          </div>
          <small class="settings-footnote">优先请求浏览器原始鼠标输入（unadjustedMovement）。系统指针加速是否绕过取决于浏览器支持；AWP 右键依次切换 40°、10°、不开镜（4:3 水平视野）。</small>
        </section>

        <section data-panel="video" hidden>
          <div class="settings-panel-head">
            <div><h3>画面与显示</h3><p>调整屏幕比例、渲染清晰度、亮度与雷达朝向，修改立即生效。</p></div>
            <button id="reset-video" class="btn-subtle" type="button">恢复默认画面</button>
          </div>
          <div class="settings-group" data-video-group="display">
            <h4>显示与雷达</h4>
            <label class="config-row"><span><strong>屏幕比例</strong><small>4:3 经典竞技视野或 16:9 宽屏</small></span><select id="cs-aspect"><option value="16:9">16:9 · 宽屏</option><option value="4:3">4:3 · 经典</option></select></label>
            <label class="config-row"><span><strong>显示模式</strong><small>4:3 在宽屏下选择黑边或全屏拉伸</small></span><select id="cs-display"><option value="bars">保持比例 · 黑边</option><option value="stretch">拉伸至全屏</option></select></label>
          </div>
          <div class="settings-group" data-video-group="render">
            <h4>画质与性能</h4>
            <label class="config-row"><span><strong>画质档位</strong><small id="cs-quality-desc">默认标准档极速秒进；高画质加载 CS2 原版贴图与高清材质</small></span><select id="cs-quality"><option value="low">标准 · 极速流畅</option><option value="high">高画质 · 原版贴图</option></select></label>
          </div>
          <div class="settings-group" data-video-group="brightness">
            <h4>亮度校准</h4>
            <div class="slider-control-head">
              <div><label class="control-title" for="cs-brightness">画面亮度</label><span class="control-sub">同步影响地图、人物与第一人称武器</span></div>
              <output id="brightness-value" class="value-pill">100%</output>
            </div>
            <input id="cs-brightness" class="cs-range" aria-label="亮度" type="range" min="60" max="160" step="1">
            <div class="video-calibration" aria-label="灰度对比校准条">${[12,26,42,58,74,88,98].map(l=>`<span style="background:hsl(215 14% ${l}%)"></span>`).join('')}</div>
          </div>
        </section>

        <section data-panel="keys" hidden><div id="keybindings"></div></section>

        <section data-panel="crosshair" hidden>
          <div class="settings-panel-head">
            <div><h3>准星工坊</h3><p>支持实时拖动预览、背景对比测试及 CS2 准星分享代码导入。</p></div>
            <button id="reset-crosshair" class="btn-subtle" type="button">恢复 donk 准星</button>
          </div>
          <div class="crosshair-preview" data-bg="sand">
            <div id="crosshair-preview-reticle"></div>
            <span class="preview-caption">实时预览 · 1:1 像素对齐</span>
            <div class="preview-bg-switch" role="group" aria-label="切换准星预览背景">
              <button type="button" class="active" data-preview-bg="sand">沙地</button>
              <button type="button" data-preview-bg="dark">暗墙</button>
              <button type="button" data-preview-bg="sky">亮空</button>
              <button type="button" data-preview-bg="grid">网格</button>
            </div>
          </div>
          <div class="preset-strip crosshair-presets">
            ${CROSSHAIR_PRESETS.map(p=>`<button type="button" class="preset-chip" data-ch-preset="${p.id}"><b>${p.label}</b></button>`).join('')}
          </div>
          <div class="crosshair-import">
            <input id="crosshair-code" aria-label="CS 准星分享代码" placeholder="粘贴 CS2 分享代码：CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx">
            <button id="import-crosshair" type="button">导入代码</button>
          </div>
          <p id="crosshair-import-status" role="status"></p>
          <div id="crosshair-fields" class="crosshair-fields"></div>
          <div class="crosshair-footer-note">
            <span>当前基准：donk · 2026-09-06（Spirit vs MOUZ · Nuke）</span>
            <a class="settings-source" href="https://totalcsgo.com/crosshairs/donk" target="_blank" rel="noreferrer">查看比赛准星来源 ↗</a>
          </div>
        </section>
      </div>
    </div>
  </section>`;
  document.body.append(modal);
  const select=s=>modal.querySelector(s);
  controls.mountSettings(select('#keybindings'));
  const preview=new Crosshair(select('#crosshair-preview-reticle'),{settings:getSettings().crosshair,getViewport:crosshair.getViewport});
  let returnFocus;
  let referenceDpi=readStoredDpi();

  function activateTab(name){
    modal.querySelectorAll('.config-tabs [data-tab]').forEach(b=>b.classList.toggle('selected',b.dataset.tab===name));
    modal.querySelectorAll('.config-scroll [data-panel]').forEach(p=>p.hidden=p.dataset.panel!==name);
    if(name==='crosshair')preview.refreshLayout();
  }
  function close(){modal.hidden=true;controls.clear();returnFocus?.focus();}
  select('#close-settings').onclick=close;
  modal.addEventListener('keydown',e=>{if(e.code==='Escape'&&!e.defaultPrevented){close();e.preventDefault();}});
  modal.querySelectorAll('.config-tabs [data-tab]').forEach(button=>button.onclick=()=>activateTab(button.dataset.tab));

  function updateMouseTelemetry(sens){
    const edpi=Math.round(referenceDpi*sens);
    const cm360=(360/(0.022*sens*referenceDpi)*2.54);
    select('#mouse-edpi').textContent=String(edpi);
    select('#mouse-cm360').textContent=(cm360>=100?cm360.toFixed(0):cm360.toFixed(1))+' cm';
    select('#mouse-feel-tag').textContent=edpi<600?'极致精准':edpi<=1100?'主流竞技':edpi<=1800?'灵活中敏':'高速转向';
    modal.querySelectorAll('[data-dpi]').forEach(btn=>btn.classList.toggle('active',Number(btn.dataset.dpi)===referenceDpi));
  }

  function syncMouse(){
    const s=getSettings();
    const sens=Number(s.sensitivity)||1;
    const zoom=Number(s.zoomSensitivity)||1;
    const sensNum=select('#cs-sensitivity'), sensRange=select('#cs-sensitivity-range');
    const zoomNum=select('#cs-zoom-sensitivity'), zoomRange=select('#cs-zoom-sensitivity-range');
    if(document.activeElement!==sensNum)sensNum.value=sens.toFixed(2).replace(/\.?0+$/,'')||String(sens);
    sensRange.value=String(clampNumber(sens,0.1,50));
    setRangeFill(sensRange);
    if(document.activeElement!==zoomNum)zoomNum.value=zoom.toFixed(2).replace(/\.?0+$/,'')||String(zoom);
    zoomRange.value=String(clampNumber(zoom,0.1,5));
    setRangeFill(zoomRange);
    select('#cs-invert-y').checked=!!s.invertY;
    modal.querySelectorAll('[data-preset-key]').forEach(btn=>{
      const current=btn.dataset.presetKey==='sensitivity'?sens:zoom;
      btn.classList.toggle('active',Math.abs(current-Number(btn.dataset.presetValue))<0.015);
    });
    updateMouseTelemetry(sens);
  }

  function setMouseValue(key,rawValue,commit=true){
    const max=key==='sensitivity'?100:10;
    const n=Number(rawValue);
    if(!Number.isFinite(n)||n<0.05||n>max){
      if(commit)syncMouse();
      return;
    }
    const rounded=Math.round(n*100)/100;
    onSettings({[key]:rounded});
    syncMouse();
  }

  for(const [id,rangeId,key] of [['cs-sensitivity','cs-sensitivity-range','sensitivity'],['cs-zoom-sensitivity','cs-zoom-sensitivity-range','zoomSensitivity']]){
    const num=select('#'+id), range=select('#'+rangeId);
    range.addEventListener('input',()=>setMouseValue(key,range.value,false));
    range.addEventListener('change',()=>setMouseValue(key,range.value,true));
    num.addEventListener('input',()=>{
      const n=Number(num.value);
      if(Number.isFinite(n)&&n>=0.05&&n<=(key==='sensitivity'?100:10)){
        onSettings({[key]:n});
        range.value=String(clampNumber(n,Number(range.min),Number(range.max)));
        setRangeFill(range);
        if(key==='sensitivity')updateMouseTelemetry(n);
      }
    });
    num.addEventListener('change',()=>setMouseValue(key,num.value,true));
  }
  modal.querySelectorAll('[data-step-target]').forEach(btn=>{
    btn.onclick=()=>{
      const key=btn.dataset.stepTarget, rawDelta=Number(btn.dataset.stepDelta);
      const cur=Number(getSettings()[key])||1;
      const step=key==='sensitivity'?(cur>=10?1:cur>=3?0.25:0.1)*Math.sign(rawDelta):rawDelta;
      setMouseValue(key,clampNumber(Math.round((cur+step)*100)/100,0.05,key==='sensitivity'?100:10),true);
    };
  });
  modal.querySelectorAll('[data-preset-key]').forEach(btn=>{
    btn.onclick=()=>setMouseValue(btn.dataset.presetKey,Number(btn.dataset.presetValue),true);
  });
  modal.querySelectorAll('[data-dpi]').forEach(btn=>{
    btn.onclick=()=>{
      referenceDpi=Number(btn.dataset.dpi);
      try{localStorage.setItem('dust2.mouse-dpi',String(referenceDpi));}catch{}
      updateMouseTelemetry(Number(getSettings().sensitivity)||1);
    };
  });
  select('#cs-invert-y').onchange=e=>onSettings({invertY:e.target.checked});
  select('#reset-mouse').onclick=()=>{
    onSettings({sensitivity:1,zoomSensitivity:1,invertY:false});
    syncMouse();
  };

  for(const key of ['aspect','display'])select('#cs-'+key).onchange=e=>onSettings({[key]:e.target.value});
  const radarRow=document.createElement('label');
  radarRow.className='config-row';
  radarRow.innerHTML='<span><strong>雷达方向</strong><small>小地图随视角旋转或保持固定北向</small></span><select id="cs-radar-direction"><option value="view">跟随视角</option><option value="north">固定北方</option></select>';
  select('#cs-display').closest('label').after(radarRow);
  select('#cs-radar-direction').onchange=e=>onSettings({radarRotate:e.target.value==='view'});
  const resolutionRow=document.createElement('label');
  resolutionRow.className='config-row';
  resolutionRow.innerHTML='<span><strong>极简模式渲染比例</strong><small>当前分辨率：<output id="cs-render-dimensions"></output></small></span><select id="cs-flat-render-scale" aria-label="极简模式渲染比例"><option value="0.75">75%</option><option value="1">100% · 原生优先</option><option value="1.25">125%</option><option value="1.5">150%</option></select>';
  select('#cs-quality').closest('label').after(resolutionRow);
  select('#cs-flat-render-scale').onchange=e=>{onSettings({flatRenderScale:Number(e.target.value)});videoRefresh();};
  const clarityRow=document.createElement('label');clarityRow.className='config-row';clarityRow.hidden=!mobileDevice();
  clarityRow.innerHTML='<span><strong>手机清晰度</strong><small>默认「清晰」兼顾细节与流畅，立即生效</small></span><select id="cs-mobile-clarity"><option value="performance">省电 · 降低分辨率</option><option value="clear">清晰 · 推荐</option><option value="sharp">高清 · 更精细</option></select>';
  select('#cs-quality').closest('label').after(clarityRow);
  select('#cs-mobile-clarity').onchange=e=>{onSettings({mobileClarity:e.target.value});videoRefresh();};

  function videoRefresh(){
    select('#cs-radar-direction').value=getSettings().radarRotate===false?'north':'view';
    select('#cs-flat-render-scale').value=String(getSettings().flatRenderScale||1);
    select('#cs-mobile-clarity').value=getSettings().mobileClarity||'clear';
    for(const key of ['aspect','display'])select('#cs-'+key).value=getSettings()[key];
    select('#cs-quality').value=getSettings().quality;
    const descEl=select('#cs-quality-desc');
    if(descEl){
      const pm=globalThis.__DUST2_PRIVATE_MAP__;
      if(pm?.texturedRender){
        descEl.textContent='支持局内实时切换：标准（极速轻量）/ 高画质（CS2 原版完整贴图）';
      }else if(pm){
        descEl.textContent='当前地图无原版贴图包，高画质将启用高清材质增强与更高清晰度（沙二支持完整贴图）';
      }else{
        descEl.textContent='默认标准档极速秒进；高画质为炙热沙城 II 加载 CS2 原版完整贴图，其余地图启用高清材质增强';
      }
    }
    const brightnessEl=select('#cs-brightness');
    brightnessEl.value=getSettings().brightness;
    setRangeFill(brightnessEl);
    select('#brightness-value').textContent=`${getSettings().brightness}%`;
  }
  select('#cs-quality').onchange=e=>onSettings({quality:e.target.value});
  select('#cs-brightness').oninput=e=>{onSettings({brightness:Number(e.target.value)});videoRefresh();};
  select('#reset-video').onclick=()=>{onSettings({radarRotate:true,flatRenderScale:1,mobileClarity:'clear',quality:'low',brightness:100,...videoDefaults});videoRefresh();};
  videoRefresh();

  const sliderFields=[
    ['size','长度',0,10,.1],
    ['thickness','粗细',0,5,.1],
    ['gap','间距',-10,10,.1],
    ['alpha','透明度',0,255,1],
    ['outlineThickness','描边粗细',0,3,.5],
  ];
  const colorFields=[
    ['red','红 (R)',0,255,1],
    ['green','绿 (G)',0,255,1],
    ['blue','蓝 (B)',0,255,1],
  ];
  const toggleFields=[
    ['dot','中心点'],
    ['outline','外框描边'],
    ['tStyle','T 字形'],
    ['followRecoil','跟随后坐力'],
  ];
  select('#crosshair-fields').innerHTML=`
    <div class="settings-group">
      <h4>颜色与快捷色板</h4>
      <div class="color-swatch-bar">
        <div class="swatch-list">${COLOR_SWATCHES.map(c=>`<button type="button" class="color-swatch" data-swatch="${c.rgb.join(',')}" style="background:rgb(${c.rgb.join(',')})" title="${c.label}" aria-label="准星颜色：${c.label}"></button>`).join('')}</div>
        <label class="color-picker-wrap"><span>自定义颜色</span><input id="crosshair-color-picker" type="color" aria-label="自定义准星颜色"></label>
      </div>
      <div class="crosshair-sliders">
        ${colorFields.map(([key,label,min,max,step])=>`<div class="ch-slider-row"><label>${label}</label><input type="range" class="cs-range" data-crosshair-range="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label}"><input data-crosshair="${key}" type="number" min="${min}" max="${max}" step="${step}"></div>`).join('')}
      </div>
    </div>
    <div class="settings-group">
      <h4>尺寸与几何参数</h4>
      <div class="crosshair-sliders">
        ${sliderFields.map(([key,label,min,max,step])=>`<div class="ch-slider-row"><label>${label}</label><input type="range" class="cs-range" data-crosshair-range="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label}"><input data-crosshair="${key}" type="number" min="${min}" max="${max}" step="${step}"></div>`).join('')}
      </div>
    </div>
    <div class="settings-group">
      <h4>样式开关</h4>
      <div class="crosshair-toggles">
        ${toggleFields.map(([key,label])=>`<label class="toggle-tile"><span>${label}</span><input data-crosshair="${key}" type="checkbox"></label>`).join('')}
      </div>
    </div>`;

  function syncCrosshairExtras(settings){
    const picker=select('#crosshair-color-picker');
    if(picker)picker.value=rgbToHex(settings.red,settings.green,settings.blue);
    for(const r of modal.querySelectorAll('[data-crosshair-range]')){
      const v=settings[r.dataset.crosshairRange];
      r.value=String(clampNumber(Number(v),Number(r.min),Number(r.max)));
      setRangeFill(r);
    }
    modal.querySelectorAll('[data-swatch]').forEach(btn=>{
      const [r,g,b]=btn.dataset.swatch.split(',').map(Number);
      btn.classList.toggle('active',settings.red===r&&settings.green===g&&settings.blue===b);
    });
  }

  function refresh(value){
    const settings=normalizeCrosshair(value);
    onSettings({crosshair:settings});
    crosshair.configure(settings);
    preview.configure(settings);
    preview.update({alive:true});
    for(const el of modal.querySelectorAll('[data-crosshair]')){
      const v=settings[el.dataset.crosshair];
      if(el.type==='checkbox')el.checked=!!v;
      else if(document.activeElement!==el)el.value=v;
    }
    syncCrosshairExtras(settings);
  }

  for(const el of modal.querySelectorAll('[data-crosshair]')){
    const updateField=()=>{
      if(el.type==='number'&&!Number.isFinite(Number(el.value)))return;
      refresh({...getSettings().crosshair,...(['red','green','blue'].includes(el.dataset.crosshair)?{color:5}:{}),[el.dataset.crosshair]:el.type==='checkbox'?el.checked:Number(el.value)});
    };
    el.oninput=updateField;
    el.onchange=updateField;
  }
  for(const r of modal.querySelectorAll('[data-crosshair-range]')){
    const key=r.dataset.crosshairRange;
    r.addEventListener('input',()=>{
      refresh({...getSettings().crosshair,...(['red','green','blue'].includes(key)?{color:5}:{}),[key]:Number(r.value)});
    });
  }
  modal.querySelectorAll('[data-swatch]').forEach(btn=>{
    btn.onclick=()=>{
      const [red,green,blue]=btn.dataset.swatch.split(',').map(Number);
      refresh({...getSettings().crosshair,color:5,red,green,blue});
    };
  });
  select('#crosshair-color-picker')?.addEventListener('input',e=>{
    const rgb=hexToRgb(e.target.value);
    if(rgb)refresh({...getSettings().crosshair,color:5,red:rgb[0],green:rgb[1],blue:rgb[2]});
  });
  modal.querySelectorAll('[data-preview-bg]').forEach(btn=>{
    btn.onclick=()=>{
      modal.querySelectorAll('[data-preview-bg]').forEach(b=>b.classList.toggle('active',b===btn));
      select('.crosshair-preview').dataset.bg=btn.dataset.previewBg;
    };
  });
  modal.querySelectorAll('[data-ch-preset]').forEach(btn=>{
    btn.onclick=()=>{
      const found=CROSSHAIR_PRESETS.find(p=>p.id===btn.dataset.chPreset);
      if(found){
        refresh({...found.settings});
        select('#crosshair-import-status').textContent=`已应用「${found.label}」准星预设。`;
      }
    };
  });
  select('#reset-crosshair').onclick=()=>{refresh({...DEFAULT_CROSSHAIR});select('#crosshair-import-status').textContent='已恢复 donk 比赛准星。';};
  select('#import-crosshair').onclick=()=>{try{refresh(decodeCrosshairCode(select('#crosshair-code').value.trim()));select('#crosshair-import-status').textContent='准星已导入并保存。';}catch(error){select('#crosshair-import-status').textContent=error.message;}};
  refresh(getSettings().crosshair);
  syncMouse();
  return {
    element:modal,
    syncMouse,
    open(){
      videoRefresh();
      syncMouse();
      returnFocus=document.activeElement;
      controls.clear();
      modal.hidden=false;
      preview.refreshLayout();
      select('#close-settings').focus();
    },
    close
  };
}
