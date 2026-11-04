import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";

import { EventCollectionService } from "@bitwarden/common/dirt/event-logs";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { SendAccessView } from "@bitwarden/common/tools/send/models/view/send-access.view";
import { ViewPasswordHistoryService } from "@bitwarden/common/vault/abstractions/view-password-history.service";
import { CipherType, FieldType } from "@bitwarden/common/vault/enums";
import { ToastService } from "@bitwarden/components";
import { CipherViewComponent, VaultViewPasswordHistoryService } from "@bitwarden/vault";

import { SharedModule } from "../../../shared";

@Component({
  selector: "app-send-access-item",
  templateUrl: "send-access-item.component.html",
  imports: [SharedModule, CipherViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      // This is required to make the CipherViewComponent work
      provide: ViewPasswordHistoryService,
      useClass: VaultViewPasswordHistoryService,
    },
    {
      // Event collection requires the user to be logged in, which won't be the case
      // for many/most Send accesses. Instead we replace the methods with no-ops here.
      // TODO: It'd be better if the EventCollectionService could tolerate anonymous callers
      provide: EventCollectionService,
      useValue: { collect: () => {}, collectMany: () => {} },
    },
  ],
})
export class SendAccessItemComponent {
  private readonly platformUtilsService = inject(PlatformUtilsService);
  private readonly toastService = inject(ToastService);
  private readonly i18nService = inject(I18nService);

  readonly FieldType = FieldType;

  readonly send = input.required<SendAccessView>();
  readonly cipher = computed(() => this.send().data.data);
  readonly launchUri = computed(() => {
    const c = this.cipher();
    const uri = c?.login?.uris?.find((u) => !!u.uri)?.uri;
    if (!uri) {
      return null;
    }
    return /^https?:\/\//i.test(uri) ? uri : `https://${uri}`;
  });

  protected readonly CipherType = CipherType;

  protected copyValue(value: string | undefined | null, labelKey: string): void {
    if (!value) {
      return;
    }
    this.platformUtilsService.copyToClipboard(value);
    this.toastService.showToast({
      variant: "success",
      title: undefined,
      message: this.i18nService.t("valueCopied", this.i18nService.t(labelKey)),
    });
  }

  protected openWebsite(): void {
    const uri = this.launchUri();
    if (uri) {
      this.platformUtilsService.launchUri(uri);
    }
  }
}
