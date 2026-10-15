import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Claim } from './claim/claim';
import { AuditScreen } from './audit/audit';
import { McpInstall } from './mcp-install/mcp-install';
import { ModelsScreen } from './models/model-registry';
import { SpendingScreen } from './spending/spending';
import { IntegrationRegister } from './integrations/integration-register';
import { IntegrationDetail } from './integrations/integration-detail';
import { ToolAccessExplanation } from './integrations/tool-access-explanation';
import { ToolPolicyScreen } from './tool-policy/tool-policy';
import { Workspace } from './chat/workspace';
import { DirectChat } from './chat/direct-chat';
import { Conversations } from './chat/conversations';
import { SignIn } from './sign-in/sign-in';
import { SharedState } from './shared-state/shared-state';
import { StateSpecimen } from './shared-state/state-specimen';
import { OrganisationShell } from './organisation/organisation-shell';
import { assistantCreateGroupId, normalisePathname, organisationPage,
  organisationPageLabel, peopleGroupId, peopleMemberId, toolExplanationServerId }
  from './organisation/pages';
import { AccountScreen } from './settings/account-screen';
import { PersonalSettingsShell } from './settings/personal-settings-shell';
import { PeopleScreen } from './people/people-screen';
import { GroupDetailScreen } from './people/group-detail-screen';
import { MemberDetailScreen } from './people/member-detail-screen';
import { SharedAssistantAdmin } from './people/shared-assistant-admin';
import { OwnershipScreen } from './people/ownership-screen';
import { SharedAssistantPicker } from './chat/shared-assistant-picker';
import { personalSettingsPage, personalSettingsPageLabel } from './settings/pages';
import { SurveyScreen } from './welcome/survey';

@Component({
  selector: 'app-root',
  imports: [
    Claim, StateSpecimen, McpInstall, SharedState, SignIn, Workspace, DirectChat, Conversations,
    ToolPolicyScreen, ToolAccessExplanation,
    ModelsScreen, SpendingScreen, AuditScreen, IntegrationRegister, IntegrationDetail,
    OrganisationShell,
    AccountScreen, PersonalSettingsShell, PeopleScreen, GroupDetailScreen, MemberDetailScreen,
    SharedAssistantAdmin, SharedAssistantPicker, OwnershipScreen, SurveyScreen,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.workspace-root]': 'workspacePage || directChatPage || conversationsPage',
    '[class.settings-root]': 'accountPath',
  },
})
export class App {
  private readonly pathname = normalisePathname(globalThis.location.pathname);
  protected readonly claimPage = this.pathname === '/claim';
  protected readonly workspacePage = this.pathname === '/workspace';
  protected readonly directChatPage = this.pathname === '/workspace/direct';
  protected readonly conversationsPage = this.pathname === '/workspace/conversations';
  protected readonly sharedAssistantPickerPage = this.pathname === '/workspace/shared';
  protected readonly orgPage = this.pathname === '/org' || this.pathname.startsWith('/org/');
  protected readonly settingsPage = personalSettingsPage(this.pathname);
  protected readonly accountPath = this.pathname === '/account'
    || this.pathname.startsWith('/account/');
  protected readonly surveyPage = this.pathname === '/welcome/survey';
  protected readonly activePage = organisationPage(this.pathname);
  protected readonly peopleGroupId = peopleGroupId(this.pathname);
  protected readonly peopleMemberId = peopleMemberId(this.pathname);
  protected readonly ownershipPage = this.pathname === '/org/people/owners';
  protected readonly assistantCreateGroupId = assistantCreateGroupId(this.pathname);
  protected readonly installPage = this.pathname === '/org/integrations/new';
  protected readonly toolServer = /^\/org\/integrations\/([\w-]+)\/tools$/u.exec(this.pathname)?.[1];
  protected readonly explanationServer = toolExplanationServerId(this.pathname);
  protected readonly detailServer = this.installPage
    ? undefined
    : /^\/org\/integrations\/([\w-]+)$/u.exec(this.pathname)?.[1];
  protected readonly auditConversation = /^\/history\/([\w-]+)$/u.exec(this.pathname)?.[1];
  protected readonly statesPage = this.pathname === '/org/states';
  protected readonly organisation = document
    .querySelector<HTMLMetaElement>('meta[name=opencrane-org]')?.content || 'Your organisation';
  protected readonly personalSettingsPageLabel = personalSettingsPageLabel;

  protected unavailableTitle(): string {
    return organisationPageLabel(this.activePage) ?? 'Page not found';
  }
}
