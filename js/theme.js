// Themes, picked in the settings popup and stored as <html data-theme>. Loaded in <head>
// (before the stylesheet paints) so the saved theme applies with no flash of the default one.
const THEME_KEY = 'roomPuzzle.theme';
const THEMES = ['light', 'dark', 'ivory', 'med', 'rococo', 'cyber'];

function currentTheme(){
  const v = document.documentElement.dataset.theme;
  return THEMES.includes(v) ? v : 'light';
}

try {
  const saved = localStorage.getItem(THEME_KEY);
  document.documentElement.dataset.theme = THEMES.includes(saved) ? saved : 'light';
}
catch(e){ document.documentElement.dataset.theme = 'light'; }
