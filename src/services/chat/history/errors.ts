import type { TranslationKey } from '../../../i18n/index.js'

/** 导入导出失败的原因，key 对应界面提示文案。 */
export class BackupError extends Error {
  constructor(readonly key: TranslationKey) {
    // 展示时再翻译，归档解析也可在没有页面设置的后台线程中使用。
    super(key)
    this.name = 'BackupError'
  }
}

export const fail = (key: TranslationKey): never => {
  throw new BackupError(key)
}
