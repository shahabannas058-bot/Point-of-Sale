import '@fontsource-variable/inter/wght.css';
import './styles/index.css';

import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Loader } from './components/Loader';
import { App } from './App';
import { bootstrap, installGlobalErrorLogging, type BootResult } from './bootstrap';
import { translate } from './i18n';
import { installGlassShine } from './lib/glass';
import { applyPrefsToDocument, usePrefs } from './store/prefs';

installGlobalErrorLogging(window);
applyPrefsToDocument();
installGlassShine();

function Boot(): ReactNode {
  const [state, setState] = useState<BootResult | null>(null);
  useEffect(() => {
    void bootstrap().then(setState);
  }, []);
  const lang = usePrefs((s) => s.lang);

  if (!state) return <Loader label={translate(lang, 'boot.loading')} />;
  if (state.kind === 'locked')
    return (
      <Loader
        title={translate(lang, 'boot.otherTab')}
        label={translate(lang, 'boot.otherTabHint')}
        still
      />
    );
  if (state.kind === 'error')
    return (
      <Loader
        title={translate(lang, 'boot.failed')}
        label={state.error instanceof Error ? state.error.message : String(state.error)}
        still
      />
    );
  return <App runtime={state.runtime} />;
}

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
