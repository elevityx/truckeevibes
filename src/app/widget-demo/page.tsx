// W2.3: the widget demo (noindex, not in the sitemap). Loads the committed, SRI-pinned release file exactly as a host page would.
import type { Metadata } from 'next';
import manifest from '../../../public/widget/manifest.json';
import { WIDGET_VERSION } from '../../../widget/src/version';
import WidgetDemo from './WidgetDemo';

export const metadata: Metadata = {
  title: 'TruckeeVibes widget demo',
  description: 'The TruckeeVibes events widget on synthetic data.',
  robots: { index: false, follow: false },
};

function currentRelease() {
  const r = manifest.versions.find((v) => v.version === WIDGET_VERSION);
  if (!r) throw new Error(`widget-demo: no manifest entry for ${WIDGET_VERSION}; run npm run widget:build`);
  return r;
}

export default function Page() {
  const release = currentRelease();
  return <WidgetDemo src={release.file} integrity={release.integrity} />;
}
