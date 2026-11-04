const mermaid = window.mermaid;

/** @type {import('mermaid').MermaidConfig} */
const configuration = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  logLevel: 'fatal',
  suppressErrorRendering: true,
  maxTextSize: 50_000,
  maxEdges: 500,
  // Keep reply directives from changing security settings or logging reply text.
  secure: ['secure', 'securityLevel', 'startOnLoad', 'logLevel', 'maxTextSize',
    'suppressErrorRendering', 'maxEdges', 'htmlLabels'],
};
mermaid.initialize(configuration);

// Block every network load before accepting reply text, including scripts from this website.
// Load the complete library first so rendering never needs another script or stylesheet.
const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; "
  + "base-uri 'none'; form-action 'none'";
document.head.append(policy);

/** @param {MessageEvent<unknown>} event */
function receiveDiagram(event) {
  const request = event.data;
  if (event.source !== parent || typeof request !== 'object' || request === null
    || !('id' in request) || typeof request.id !== 'number' || !Number.isSafeInteger(request.id)
    || !('code' in request) || typeof request.code !== 'string') {
    return;
  }
  void drawDiagram(request.id, request.code);
}

/**
 * @param {number} id
 * @param {string} code
 */
async function drawDiagram(id, code) {
  try {
    // Refuse resource shapes early. The browser policy also blocks syntax we do not recognise.
    const resourceSyntax = /\b(?:img|icon)\s*:|<\s*(?:img|image)\b|url\s*\(/i;
    if (code.length > 50_000 || resourceSyntax.test(code)) {
      throw new Error('Unsupported diagram');
    }
    const result = await mermaid.render(`reply-diagram-${String(id)}`, code);
    const response = { id, svg: result.svg };
    parent.postMessage(response, '*');
  } catch {
    // Return no library error text because it can contain private reply content.
    const response = { id };
    parent.postMessage(response, '*');
  }
}

window.addEventListener('message', receiveDiagram);
parent.postMessage('mermaid-ready', '*');
