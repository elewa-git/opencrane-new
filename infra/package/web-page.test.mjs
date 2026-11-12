import assert from 'node:assert/strict';
import { test } from 'node:test';
import { organisationPage } from './web-page.mjs';

const page = '<html><head><meta name="opencrane-org" content=""></head><body></body></html>';

function escapesOrganisationName() {
  const rendered = organisationPage(page, '<Acme "&" Sons> $&');
  assert.equal(rendered, '<html><head><meta name="opencrane-org" '
    + 'content="&lt;Acme &quot;&amp;&quot; Sons&gt; $&amp;"></head><body></body></html>');
}

function leavesAnEmptyName() {
  assert.equal(organisationPage(page, ''), page);
  assert.equal(organisationPage(page, undefined), page);
}

test('the public page escapes an installation name as HTML attribute text', escapesOrganisationName);
test('the public page keeps the empty name when the setting is absent', leavesAnEmptyName);
