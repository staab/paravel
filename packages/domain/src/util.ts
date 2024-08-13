import type {EventContent, ExtensibleTrustedEvent} from "@welshman/util"

export type Encrypt = (x: string) => Promise<string>

export type DecryptedEvent = ExtensibleTrustedEvent & {
  plaintext: Partial<EventContent>
}

export const asDecryptedEvent = (event: ExtensibleTrustedEvent, plaintext: Partial<EventContent>) =>
  ({...event, plaintext}) as DecryptedEvent

export class Encryptable<E extends Partial<EventContent>> {
  constructor(readonly event: E, readonly updates: E) {}

  async reconcile(encrypt: Encrypt) {
    const encryptContent = () => {
      if (!this.updates.content) return null

      return encrypt(this.updates.content)
    }

    const encryptTags = () => {
      if (!this.updates.tags) return null

      return Promise.all(
        this.updates.tags.map(async tag => {
          tag[1] = await encrypt(tag[1])

          return tag
        })
      )
    }

    const [content, tags] = await Promise.all([encryptContent(), encryptTags()])

    // Updates are optional. If not provided, fall back to the event's content and tags.
    return {
      ...this.event,
      tags: tags || this.event.tags || [],
      content: content || this.event.content || "",
    }
  }
}