import { HttpPortalApi } from './http-portal'
import { MockPortalApi } from './mock-portal'
import type { PortalApi } from '@/domain/portal-api'

/**
 * THE SWITCH.
 *
 * To go live: set `VITE_USE_MOCK_API=false` and point `VITE_API_BASE_URL` at
 * your service. No component, hook or type changes.
 */
const useMock = import.meta.env.VITE_USE_MOCK_API !== 'false'

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001/api'

export const portalApi: PortalApi = useMock
  ? new MockPortalApi()
  : new HttpPortalApi(baseUrl)

/** Lets UI show demo credentials only when they actually exist. */
export const isMockApi = useMock

export * from '@/domain/types'
export type { PortalApi } from '@/domain/portal-api'