# Models table screen captures

PASS: Intercepted GET replies produced all eight states at 1280px and 390px.
PASS: No captured page has horizontal overflow. Visible buttons measure at least 44px.

| Frame | Difference from the supplied design |
| --- | --- |
| MOD-01 | The provider and model empty messages are separate. The page does not say that nobody has a grant. |
| MOD-02 | Names, grants and counts come from fixture replies. The model says Enabled; the provider keeps its separate saved and verification facts. |
| MOD-02-UPDATING | An applying grant reply says Still updating and leaves assistant access unchecked. It makes no missing-grant claim. |
| MOD-02-UNCHECKED | A default binding counts two assistants, but the names reply lists one. The table leaves assistant access unchecked. |
| MOD-02-RM | The data matches MOD-02. The browser uses reduced motion. |
| MOD-03 | The dated rows remain after a failed refresh. Provider actions are disabled. |
| MOD-04 | The current server role refusal replaces the proposed read-only view. |
| MOD-06 | The phone uses the existing organisation menu. Desktop keeps its sidebar. |

The pictures use intercepted replies. A fresh-install provider journey is NOT RUN.
