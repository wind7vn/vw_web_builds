import { firstValueFrom, switchMap } from "rxjs";

// eslint-disable-next-line no-restricted-imports
import { LegacyCompatKeyService, SymmetricCryptoKey } from "@bitwarden/legacy-crypto";
import { SendClient } from "@bitwarden/sdk-internal";
import { UserId } from "@bitwarden/user-core";

import { FeatureFlag } from "../../../enums/feature-flag.enum";
import { ConfigService } from "../../../platform/abstractions/config/config.service";
import { SdkService } from "../../../platform/abstractions/sdk/sdk.service";
import { Utils } from "../../../platform/misc/utils";
import { Send } from "../models/domain/send";
import { SendAccess } from "../models/domain/send-access";
import { SendAccessResponse } from "../models/response/send-access.response";
import { SendAccessView } from "../models/view/send-access.view";
import { SendItemView } from "../models/view/send-item.view";
import { SendView } from "../models/view/send.view";
import { SendType } from "../types/send-type";
import { CipherView } from "../../../vault/models/view/cipher.view";

export const VW_ITEM_SHARE_MARKER = "__vw_item_share";

export function unwrapVwSharedItemSendView(sendView: SendView): SendView {
  if (
    sendView?.type === SendType.Text &&
    typeof sendView.text?.text === "string" &&
    sendView.text.text.includes(`"${VW_ITEM_SHARE_MARKER}":1`)
  ) {
    try {
      const parsed = JSON.parse(sendView.text.text);
      if (parsed && parsed[VW_ITEM_SHARE_MARKER] === 1 && parsed.cipher) {
        sendView.type = SendType.Item;
        sendView.data = new SendItemView();
        sendView.data.data = CipherView.fromJSON(parsed.cipher);
        if (Array.isArray(parsed.emails) && (!sendView.emails || sendView.emails.length === 0)) {
          sendView.emails = parsed.emails;
        }
      }
    } catch {
      // Ignore malformed JSON and leave as normal Text Send
    }
  }
  return sendView;
}

export function unwrapVwSharedItemSendAccessView(sendAccessView: SendAccessView): SendAccessView {
  if (
    sendAccessView?.type === SendType.Text &&
    typeof sendAccessView.text?.text === "string" &&
    sendAccessView.text.text.includes(`"${VW_ITEM_SHARE_MARKER}":1`)
  ) {
    try {
      const parsed = JSON.parse(sendAccessView.text.text);
      if (parsed && parsed[VW_ITEM_SHARE_MARKER] === 1 && parsed.cipher) {
        sendAccessView.type = SendType.Item;
        sendAccessView.data = new SendItemView();
        sendAccessView.data.data = CipherView.fromJSON(parsed.cipher);
      }
    } catch {
      // Ignore malformed JSON and leave as normal Text Send
    }
  }
  return sendAccessView;
}

/**
 * Service for doing specific decryption operations for Send and SendAccess objects. It is expected
 * that this service will be deprecated once Sends are fully transferred to using the SDK and no
 * longer primarily operate on Sends, but on SendViews
 */
export class SendDecryptionService {
  constructor(
    private sdkService: SdkService,
    private configService: ConfigService,
    private legacyCompatKeyService: LegacyCompatKeyService,
  ) {}

  async decryptSend(send: Send, userId: UserId): Promise<SendView> {
    const useSdkForSends = await this.configService.getFeatureFlag(FeatureFlag.Pm30110SdkSendsApi);
    if (useSdkForSends) {
      return await firstValueFrom(
        this.sdkService.userClient$(userId).pipe(
          switchMap(async (sdk) => {
            if (!sdk) {
              throw new Error("SDK not available");
            }
            using ref = sdk.take();
            const sendsClient = ref.value.sends();
            const sdkSendView = sendsClient.decrypt_send(send.toSdkSend());
            const sendView = SendView.fromSdkSendView(sdkSendView);
            const decKey = await this.legacyCompatKeyService.makeSendKey(sendView.key);
            sendView.cryptoKey = decKey;
            return unwrapVwSharedItemSendView(sendView);
          }),
        ),
      );
    } else {
      return unwrapVwSharedItemSendView(await send.decrypt(userId));
    }
  }

  async decryptSends(sends: Send[], userId: UserId): Promise<SendView[]> {
    const useSdkForSends = await this.configService.getFeatureFlag(FeatureFlag.Pm30110SdkSendsApi);
    if (useSdkForSends) {
      return await firstValueFrom(
        this.sdkService.userClient$(userId).pipe(
          switchMap(async (sdk) => {
            if (!sdk) {
              throw new Error("SDK not available");
            }
            using ref = sdk.take();
            const sendsClient = ref.value.sends();
            const sendViews = sends.map((s) =>
              unwrapVwSharedItemSendView(
                SendView.fromSdkSendView(sendsClient.decrypt_send(s.toSdkSend())),
              ),
            );
            for (const s of sendViews) {
              s.cryptoKey = await this.legacyCompatKeyService.makeSendKey(s.key);
            }
            return sendViews;
          }),
        ),
      );
    } else {
      // `pm-30110-sdk-sends-api` should be enabled and stable before `pm-34203-temporary-item-sharing`
      // is and the server should filter out any Item Sends if the latter is off, but just to be safe
      // we filter here as well.
      const nonItemSends = sends.filter((s) => s.type !== SendType.Item);
      const decrypted = await Promise.all(nonItemSends.map((s) => s.decrypt(userId)));
      return decrypted.map((s) => unwrapVwSharedItemSendView(s));
    }
  }

  async decryptSendAccess(
    sendResponse: SendAccessResponse,
    keyArray: Uint8Array,
  ): Promise<[SendAccessView, SymmetricCryptoKey]> {
    const useSdkForSends = await this.configService.getFeatureFlag(FeatureFlag.Pm30110SdkSendsApi);
    const decKey = await this.legacyCompatKeyService.makeSendKey(keyArray);
    if (useSdkForSends) {
      const sdkAccessResponse = SendAccessResponse.toSdkAccessResponse(sendResponse);
      const key = Utils.fromArrayToUrlB64(keyArray);
      const sdkSendAccessView = SendClient.decrypt_send_access(key, sdkAccessResponse);
      return [unwrapVwSharedItemSendAccessView(SendAccessView.fromSdk(sdkSendAccessView)), decKey];
    } else {
      const sendAccess = new SendAccess(sendResponse);
      const sendAccessView = await sendAccess.decrypt(decKey);
      return [unwrapVwSharedItemSendAccessView(sendAccessView), decKey];
    }
  }
}
