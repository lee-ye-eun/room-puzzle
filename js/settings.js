// Settings popup: theme picker plus rendering of the volume/language controls.
// (THEMES / currentTheme live in theme.js, volumes in audio.js, the language in i18n.js.)

// ---- theme ----
function setTheme(value){
  const theme = THEMES.includes(value) ? value : 'light';
  const changed = theme !== currentTheme();
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch(e){}
  if(changed) startBgm(true);
  renderSettings();
}

function renderSettings(){
  for(const kind of ['bgm', 'sfx']){
    const level = volumes[kind];
    document.querySelectorAll(`#${kind}Bar .sound-seg`).forEach((seg, k) => {
      seg.classList.toggle('on', k < level);
    });
    document.getElementById(kind + 'Bar').setAttribute('aria-valuenow', level);
    document.getElementById(kind + 'Down').disabled = level <= 0;
    document.getElementById(kind + 'Up').disabled = level >= SOUND_MAX;
  }
  document.getElementById('langSelect').value = lang;
  document.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.setAttribute('aria-checked', String(btn.dataset.themeValue === currentTheme()));
  });
}

function settingsOpen(){ return !document.getElementById('settingsModal').hidden; }

function openSettings(){
  renderSettings();
  document.getElementById('settingsModal').hidden = false;
  document.getElementById('langSelect').focus();
}

function closeSettings(){
  if(!settingsOpen()) return;
  document.getElementById('settingsModal').hidden = true;
  document.getElementById('settingsBtn').focus();
}

function toggleSettings(){ settingsOpen() ? closeSettings() : openSettings(); }

document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  e.preventDefault();
  toggleSettings();
});
