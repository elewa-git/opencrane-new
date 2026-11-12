export function organisationPage(page, name = '') {
  let escapedName = name.replaceAll('&', '&amp;');
  escapedName = escapedName.replaceAll('<', '&lt;');
  escapedName = escapedName.replaceAll('>', '&gt;');
  escapedName = escapedName.replaceAll('"', '&quot;');
  escapedName = escapedName.replaceAll("'", '&#39;');

  function insertName(_match, opening, closing) {
    return `${opening}${escapedName}${closing}`;
  }
  return page.replace(/(<meta name="opencrane-org" content=")[^"]*(")/u, insertName);
}
