import { useEffect, useState } from 'react';

const parse = () => {
  const raw = window.location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, params: Object.fromEntries(new URLSearchParams(qs)) };
};

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const href = (path, params = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  return `#${path}${qs ? `?${qs}` : ''}`;
};
export const navigate = (path, params) => { window.location.hash = href(path, params).slice(1); };
/** Filter changes replace the current history entry instead of piling up. */
export const replaceRoute = (path, params) => window.location.replace(href(path, params));
