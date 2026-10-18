// Bundle entry: the global `TruckeeVibes = { createController, version }` (esbuild iife, globalName TruckeeVibes).
import { WIDGET_VERSION } from './version';

export { createController } from './controller';
export const version = WIDGET_VERSION;
