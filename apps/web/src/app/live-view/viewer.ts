import viewerModule from '@novnc/novnc/lib/rfb.js';

// The production build wraps the CommonJS default; development exposes the class directly.
const viewer = typeof viewerModule === 'function' ? viewerModule : viewerModule.default;

export default viewer;
