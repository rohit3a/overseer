export type CourierSent = string[]

declare module 'claude-code' {
  interface PluginState {
    'overseer-courier': {
      sent: CourierSent
      // when the courier last ran its loop: Overseer reads it to tell "slow" from "not installed"
      heartbeat: number
    }
  }
}
