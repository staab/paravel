import {throttle} from 'throttle-debounce'
import type {IReadable, Subscriber, Invalidator} from '@welshman/lib'
import {Derived, Emitter, sortBy, customStore, inc, first, always, chunk, sleep, uniq, omit, now, range, identity} from '@welshman/lib'
import {DELETE} from './Kinds'
import {EPOCH, matchFilter, getIdFilters, matchFilters} from './Filters'
import {isReplaceable, isTrustedEvent, getAddress} from './Events'
import type {Filter} from './Filters'
import type {TrustedEvent} from './Events'

export const DAY = 86400

const getDay = (ts: number) => Math.floor(ts / DAY)

const maybeThrottle = (t: number | undefined, f: () => void) => t ? throttle(t, f) : f

export type RepositoryOptions = {
  throttle?: number
}

export class Repository extends Emitter implements IReadable<TrustedEvent[]> {
  eventsById = new Map<string, TrustedEvent>()
  eventsByAddress = new Map<string, TrustedEvent>()
  eventsByTag = new Map<string, TrustedEvent[]>()
  eventsByDay = new Map<number, TrustedEvent[]>()
  eventsByAuthor = new Map<string, TrustedEvent[]>()
  deletes = new Map<string, number>()
  subs: Subscriber<TrustedEvent[]>[] = []

  constructor(private options: RepositoryOptions) {
    super()
  }

  // Methods for implementing store interface

  get() {
    return Array.from(this.eventsById.values())
  }

  async set(events: TrustedEvent[], chunkSize = 1000) {
    for (const eventsChunk of chunk(chunkSize, events)) {
      for (const event of eventsChunk) {
        this.publish(event)
      }

      if (eventsChunk.length === chunkSize) {
        await sleep(1)
      }
    }
  }


  subscribe(f: Subscriber<TrustedEvent[]>, invalidate?: Invalidator<TrustedEvent[]>) {
    this.subs.push(f)

    return () => {
      this.subs = this.subs.filter(sub => sub !== f)
    }
  }

  derived<U>(f: (v: TrustedEvent[]) => U): Derived<U> {
    return new Derived<U>(this, f)
  }

  throttle(t: number): Derived<TrustedEvent[]> {
    return new Derived<TrustedEvent[]>(this, identity, t)
  }

  filter(getFilters: () => Filter[]) {
    const getValue = () => Array.from(this.query(getFilters()))

    return customStore<TrustedEvent[]>({
      get: getValue,
      start: setValue => {
        const onEvent = (event: TrustedEvent) => {
          if (matchFilters(getFilters(), event)) {
            setValue(getValue())
          }
        }

        const onDelete = () => {
          setValue(getValue())
        }

        this.on('event', onEvent)
        this.on('delete', onDelete)

        return () => {
          this.off('event', onEvent)
          this.off('delete', onDelete)
        }
      },
    })
  }

  notifyUpdate = maybeThrottle(this.options.throttle, () => {
    const events = this.get()

    for (const sub of this.subs) {
      sub(events)
    }

    this.emit('update')
  })

  notifyEvent = (event: TrustedEvent) => {
    this.emit('event', event)
  }

  notifyDelete = (event: TrustedEvent) => {
    this.emit('delete', event)
  }

  // API

  getEvent(idOrAddress: string) {
    return idOrAddress.includes(':')
      ? this.eventsByAddress.get(idOrAddress)
      : this.eventsById.get(idOrAddress)
  }

  hasEvent(event: TrustedEvent) {
    const duplicate = (
      this.eventsById.get(event.id) ||
      this.eventsByAddress.get(getAddress(event))
    )

    return duplicate && duplicate.created_at >= event.created_at
  }

  watchEvent(idOrAddress: string) {
    return this.filter(always(getIdFilters([idOrAddress]))).derived(first)
  }

  *query(filters: Filter[]) {
    for (let filter of filters) {
      let events: TrustedEvent[] = Array.from(this.eventsById.values())

      if (filter.ids) {
        events = filter.ids!.map(id => this.eventsById.get(id)).filter(identity) as TrustedEvent[]
        filter = omit(['ids'], filter)
      } else if (filter.authors) {
        events = uniq(filter.authors!.flatMap(pubkey => this.eventsByAuthor.get(pubkey) || []))
        filter = omit(['authors'], filter)
      } else if (filter.since || filter.until) {
        const sinceDay = getDay(filter.since || EPOCH)
        const untilDay = getDay(filter.until || now())

        events = uniq(
          Array.from(range(sinceDay, inc(untilDay)))
            .flatMap((day: number) => this.eventsByDay.get(day) || [])
        )
      } else {
        for (const [k, values] of Object.entries(filter)) {
          if (!k.startsWith('#') || k.length !== 2) {
            continue
          }

          filter = omit([k], filter)
          events = uniq(
            (values as string[]).flatMap(v => this.eventsByTag.get(`${k[1]}:${v}`) || [])
          )

          break
        }
      }

      let i = 0

      for (const event of sortBy((e: TrustedEvent) => -e.created_at, events)) {
        if (filter.limit && i > filter.limit) {
          break
        }

        if (!this.isDeleted(event) && matchFilter(filter, event)) {
          yield event
          i += 1
        }
      }
    }
  }

  publish(event: TrustedEvent) {
    if (!isTrustedEvent(event)) {
      throw new Error("Invalid event published to Repository", event)
    }

    const address = getAddress(event)
    const duplicate = (
      this.eventsById.get(event.id) ||
      this.eventsByAddress.get(address)
    )

    // If our duplicate is newer than the event we're adding, we're done
    if (duplicate && duplicate.created_at >= event.created_at) {
      return
    }

    this.eventsById.set(event.id, event)

    if (isReplaceable(event)) {
      this.eventsByAddress.set(address, event)
    }

    if (duplicate) {
      this.eventsById.delete(duplicate.id)

      if (isReplaceable(duplicate)) {
        this.eventsByAddress.delete(address)
      }
    }

    this._updateIndex(this.eventsByDay, getDay(event.created_at), event, duplicate)
    this._updateIndex(this.eventsByAuthor, event.pubkey, event, duplicate)

    // Store our event by tags
    for (const tag of event.tags) {
      if (tag[0].length === 1) {
        this._updateIndex(this.eventsByTag, tag.slice(0, 2).join(':'), event, duplicate)

        if (event.kind === DELETE) {
          const id = tag[1]
          const ts = Math.max(event.created_at, this.deletes.get(tag[1]) || 0)

          this.deletes.set(id, ts)
        }
      }
    }

    if (!this.isDeleted(event)) {
      this.notifyUpdate()
      this.notifyEvent(event)

      // Deletes are tricky, re-evaluate all subscriptions if that's what we're dealing with
      if (event.kind === DELETE) {
        this.notifyDelete(event)
      }
    }
  }

  isDeleted(event: TrustedEvent) {
    const idDeletedAt = this.deletes.get(event.id) || 0

    if (idDeletedAt > event.created_at) {
      return true
    }

    if (isReplaceable(event)) {
      const addressDeletedAt = this.deletes.get(getAddress(event)) || 0

      if (addressDeletedAt > event.created_at) {
        return true
      }
    }

    return false
  }

  // Utilities

  _updateIndex<K>(m: Map<K, TrustedEvent[]>, k: K, e: TrustedEvent, duplicate?: TrustedEvent) {
    let a = m.get(k) || []

    if (duplicate) {
      a = a.filter((x: TrustedEvent) => x !== duplicate)
    }

    a.push(e)
    m.set(k, a)
  }
}
