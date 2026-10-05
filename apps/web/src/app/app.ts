import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Claim } from './claim/claim';
import { AuditScreen } from './audit/audit';
import { McpInstall } from './mcp-install/mcp-install';
import { ModelsScreen } from './models/model-registry';
import { SpendingScreen } from './spending/spending';
import { IntegrationRegister } from './integrations/integration-register';
import { ToolPolicyScreen } from './tool-policy/tool-policy';
import { Workspace } from './chat/workspace';
import { SignIn } from './sign-in/sign-in';
import { SharedState } from './shared-state/shared-state';
import { StateSpecimen } from './shared-state/state-specimen';
import { OrganisationShell } from './organisation/organisation-shell';
import { normalisePathname, organisationPage, organisationPageLabel } from './organisation/pages';

@Component({
  selector: 'app-root',
  imports: [
    Claim, StateSpecimen, McpInstall, SharedState, SignIn, Workspace, ToolPolicyScreen,
    ModelsScreen, SpendingScreen, AuditScreen, IntegrationRegister, OrganisationShell,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.workspace-root]': 'workspacePage' },
})
export class App {
  private readonly pathname = normalisePathname(globalThis.location.pathname);
  protected readonly claimPage = this.pathname === '/claim';
  protected readonly workspacePage = this.pathname === '/workspace';
  protected readonly orgPage = this.pathname === '/org' || this.pathname.startsWith('/org/');
  protected readonly activePage = organisationPage(this.pathname);
  protected readonly installPage = this.pathname === '/org/integrations/new';
  protected readonly toolServer = /^\/org\/integrations\/([\w-]+)\/tools$/u.exec(this.pathname)?.[1];
  protected readonly auditConversation = /^\/history\/([\w-]+)$/u.exec(this.pathname)?.[1];
  protected readonly statesPage = this.pathname === '/org/states';
  protected readonly organisation = document
    .querySelector<HTMLMetaElement>('meta[name=opencrane-org]')?.content || 'Your organisation';

  protected unavailableTitle(): string {
    return organisationPageLabel(this.activePage) ?? 'Page not found';
  }
}
