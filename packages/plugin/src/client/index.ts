/** 客户端入口：把配置面板注册到 DSH「设置」的 settings.section。不 import 宿主类型。 */
import { NS, messages } from './locales.ts'
import { CapacityCard } from './CapacityCard.tsx'
import { PluginIcon } from './icon.tsx'
import { PKG, SETTINGS_SECTION_ID, SLOT_SECTION, SLOT_SECTION_ICON, SETTINGS_ORDER } from './constants.ts'

interface ClientCtx {
  effect?(fn: () => () => void): unknown
  inject?(services: string[], cb: (ctx: ClientFormCtx) => void | Promise<void>): unknown
  locale?: { register(ns: string, data: unknown): unknown }
  slots?: {
    register(spec: Record<string, unknown>, component: unknown): unknown
    inject(name: string, cb: () => unknown): unknown
  }
}
interface ClientFormCtx {
  effect?(fn: () => () => void): unknown
}

const t = messages.zh

/** 注册设置分区 + 同 id 的图标（shell 用 { only: row.id } 匹配）。 */
function registerSettingsSection(ctx: ClientCtx): void {
  try {
    const slots = ctx.slots
    if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
    slots.inject(SLOT_SECTION, () => slots.register({
      name: SLOT_SECTION,
      id: SETTINGS_SECTION_ID,
      order: SETTINGS_ORDER,
      label: () => t.title,
      locale: NS,
      inject: () => ({ t }),
    }, CapacityCard))
    slots.inject(SLOT_SECTION_ICON, () => slots.register({
      name: SLOT_SECTION_ICON,
      id: SETTINGS_SECTION_ID,
      locale: NS,
    }, PluginIcon))
  } catch (error) {
    console.error(`[${PKG}] settings section failed to register:`, error)
  }
}

export default {
  inject: ['slots', 'locale'] as const,
  apply(ctx: ClientCtx): void {
    if (ctx.effect && ctx.locale) {
      ctx.effect(() => {
        ctx.locale!.register(NS, { en: messages.en, zh: messages.zh })
        return () => {}
      })
    }
    registerSettingsSection(ctx)
  },
}
export { CapacityCard, PluginIcon }
export { PKG, SETTINGS_SECTION_ID, SLOT_SECTION, SLOT_SECTION_ICON, SETTINGS_ORDER }
