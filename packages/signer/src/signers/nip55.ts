import {SignedEvent, StampedEvent} from "@welshman/util"
import {hash, own, ISigner} from "../util"
import {NostrSignerPlugin} from "nostr-signer-capacitor-plugin"
import {nip19} from "nostr-tools"

export const getNip55 = async () => {
  const {installed} = await NostrSignerPlugin.isExternalSignerInstalled()
  return installed
}

export class Nip55Signer implements ISigner {
  #lock = Promise.resolve()
  #plugin = NostrSignerPlugin
  #packageName: string
  #packageNameSet = false
  #npub?: string
  #publicKey?: string

  constructor(packageName: string) {
    this.#packageName = packageName
	this.#initialize()
  }

  #initialize = async () => {
    if (!this.#packageNameSet) {
      await this.#plugin.setPackageName({packageName: this.#packageName})
      this.#packageNameSet = true
    }
  }


  #then = async <T>(f: (signer: typeof NostrSignerPlugin) => T | Promise<T>): Promise<T> => {
    const promise = this.#lock.then(async () => {
      if (!this.#packageNameSet) {
        await this.#plugin.setPackageName({packageName: this.#packageName})
        this.#packageNameSet = true
      }
      return f(this.#plugin)
    })

    // Recover from errors
    this.#lock = promise.then(
      () => undefined,
      () => undefined,
    )

    return promise
  }

  getPubkey = async (): Promise<string> => {
    return this.#then(async signer => {
      if (!this.#publicKey) {
        const {npub} = await signer.getPublicKey()
        this.#npub = npub
        const {data} = nip19.decode(npub)
        this.#publicKey = data as string
      }
      return this.#publicKey
    })
  }

  sign = async (template: StampedEvent): Promise<SignedEvent> => {
    const pubkey = await this.getPubkey()
    const event = hash(own(template, pubkey))

    return this.#then(async signer => {
      const {event: signedEventJson} = await signer.signEvent({
        eventJson: JSON.stringify(event),
        eventId: event.id,
        npub: pubkey,
      })
      const signedEvent = JSON.parse(signedEventJson) as SignedEvent
      return signedEvent
    })
  }

  nip04 = {
    encrypt: (pubkey: string, message: string): Promise<string> =>
      this.#then(async signer => {
        const {result} = await signer.nip04Encrypt({
          pubKey: this.#publicKey!,
          plainText: message,
          npub: pubkey,
        })
        return result
      }),
    decrypt: (pubkey: string, message: string): Promise<string> =>
      this.#then(async signer => {
        const {result} = await signer.nip04Decrypt({
          pubKey: this.#publicKey!,
          encryptedText: message,
          npub: pubkey,
        })
        return result
      }),
  }

  nip44 = {
    encrypt: (pubkey: string, message: string): Promise<string> =>
      this.#then(async signer => {
        const {result} = await signer.nip44Encrypt({
          pubKey: this.#publicKey!,
          plainText: message,
          npub: pubkey,
        })
        return result
      }),
    decrypt: (pubkey: string, message: string): Promise<string> =>
      this.#then(async signer => {
        const {result} = await signer.nip44Decrypt({
          pubKey: this.#publicKey!,
          encryptedText: message,
          npub: pubkey,
        })
        return result
      }),
  }
}
