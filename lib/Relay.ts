import {EventBus} from "./util/EventBus"

export class Relay {
  constructor(socket) {
    this.socket = socket
    this.bus = new EventBus()
    this.onMessage = this.onMessage.bind(this)

    this.socket.bus.on('message', this.onMessage)
  }
  async send(...payload) {
    await this.socket.connect()

    this.socket.send(payload)
  }
  onMessage(message) {
    const [verb, ...payload] = message

    this.bus.handle(verb, ...payload)
  }
}
