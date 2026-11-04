import { inject, Injectable, Injector } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { CipherId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  CipherViewLike,
  CipherViewLikeUtils,
} from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { ToastService } from "@bitwarden/components";

import { SHARE_ITEM_PRESENTER, ShareItemPresenter } from "../tokens/share-item-presenter.token";
import {
  SHARE_PASSWORD_REPROMPT,
  SharePasswordReprompt,
} from "../tokens/share-password-reprompt.token";

import { ShareLinkService } from "./share-link.service";

/** How a share entry point was reached, which decides whether re-prompt is owed. */
export interface ShareItemOptions {
  /**
   * Whether the user has already verified their identity to reach this entry point — true for an
   * entry point inside an item's dialog, which cannot be opened without passing re-prompt. Skips
   * asking a second time.
   */
  alreadyVerified?: boolean;
}

/**
 * Starts the share flow for a vault item.
 *
 * Owns the part of the flow every client shares — master-password re-prompt — and hands off to the
 * client's sharing surface, which decides what it needs of the item. See
 * {@link SHARE_ITEM_PRESENTER}.
 *
 * Share entry points call this so the flow stays identical wherever it is triggered from, and so
 * the Vault components hosting those entry points carry none of it.
 */
@Injectable({ providedIn: "root" })
export class ShareItemService {
  private injector = inject(Injector);

  /**
   * Re-prompts if the item requires it, then presents the client's sharing surface. Does nothing
   * if the user fails or dismisses the re-prompt.
   */
  async share(cipher: CipherViewLike, options: ShareItemOptions = {}): Promise<void> {
    // Resolved here rather than in fields so that merely rendering a share entry point does not
    // require these tokens — a client that forgot to provide one fails when sharing is attempted,
    // not when the vault list paints. The explicit type arguments keep `SafeInjectionToken`'s
    // tagged generic from widening in consuming projects.
    const presenter = this.injector.get<ShareItemPresenter>(SHARE_ITEM_PRESENTER);

    if (!options.alreadyVerified) {
      const passwordReprompt = this.injector.get<SharePasswordReprompt>(SHARE_PASSWORD_REPROMPT);

      if (!(await passwordReprompt.passwordRepromptCheck(cipher))) {
        return;
      }
    }

    await presenter.present(cipher);
  }

  /**
   * 1-Click Quick Share: creates a 24-hour share link for the item and copies it directly to the
   * clipboard without opening the options dialog.
   */
  async quickShare(
    cipher: CipherViewLike,
    options: ShareItemOptions & { expiryHours?: number; oneTimeShare?: boolean } = {},
  ): Promise<string | undefined> {
    if (!options.alreadyVerified) {
      const passwordReprompt = this.injector.get<SharePasswordReprompt>(
        SHARE_PASSWORD_REPROMPT,
        null,
      );
      if (passwordReprompt && !(await passwordReprompt.passwordRepromptCheck(cipher))) {
        return undefined;
      }
    }

    const shareLinkService = this.injector.get(ShareLinkService);
    const platformUtilsService = this.injector.get(PlatformUtilsService);
    const toastService = this.injector.get(ToastService);
    const i18nService = this.injector.get(I18nService);

    let cipherView: CipherView | undefined;
    if (!CipherViewLikeUtils.isCipherListView(cipher)) {
      cipherView = cipher;
    } else if (cipher.id != null) {
      const accountService = this.injector.get(AccountService);
      const cipherService = this.injector.get(CipherService);
      const userId = await firstValueFrom(accountService.activeAccount$.pipe(getUserId));
      cipherView = await firstValueFrom(
        cipherService.cipherView$(userId, cipher.id as unknown as CipherId),
      );
    }

    if (!cipherView) {
      toastService.showToast({
        variant: "error",
        message: i18nService.t("unknownCipher"),
      });
      return undefined;
    }

    try {
      const link = await shareLinkService.createShareLink(
        cipherView,
        [],
        options.expiryHours ?? 24,
        options.oneTimeShare ?? false,
      );
      if (link) {
        platformUtilsService.copyToClipboard(link);
        toastService.showToast({
          variant: "success",
          message: i18nService.t("linkSavedAndCopied"),
        });
        return link;
      }
      toastService.showToast({
        variant: "error",
        message: i18nService.t("linkSavedCopyFailed"),
      });
      return undefined;
    } catch {
      toastService.showToast({
        variant: "error",
        message: i18nService.t("linkSaveFailed"),
      });
      return undefined;
    }
  }
}
