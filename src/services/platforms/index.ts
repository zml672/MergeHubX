import type { Platform } from '../../types/platform'
import { githubProvider } from './github'
import { gitlabProvider } from './gitlab'
import { giteeProvider } from './gitee'
import type { PlatformProvider } from './types'

export const providers: Record<Platform, PlatformProvider> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  gitee: giteeProvider,
}

export type { PlatformProvider }
