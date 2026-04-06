import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { SchedulingWeights } from '../../shared/types'
import { appPreferenceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

const DEFAULT_WEIGHTS: SchedulingWeights = {
  dependencyFirst: 0.6,
  capabilityMatch: 0.3,
  leastBusy: 0.1
}

export function registerSchedulingIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SCHEDULING_GET_WEIGHTS, async (event) => {
    validateSender(event)
    const raw = appPreferenceRepository.get('scheduling.weights')
    if (!raw) return DEFAULT_WEIGHTS
    try {
      return JSON.parse(raw) as SchedulingWeights
    } catch {
      return DEFAULT_WEIGHTS
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.SCHEDULING_SET_WEIGHTS,
    async (event, weights: SchedulingWeights) => {
      validateSender(event)

      if (!weights || typeof weights !== 'object') {
        throw new Error('Invalid weights object')
      }

      const { dependencyFirst, capabilityMatch, leastBusy } = weights

      // Validate each weight is between 0 and 1
      if (
        [dependencyFirst, capabilityMatch, leastBusy].some(
          (w) => typeof w !== 'number' || w < 0 || w > 1
        )
      ) {
        throw new Error('Each weight must be a number between 0 and 1')
      }

      // Validate weights sum to ~1.0
      const sum = dependencyFirst + capabilityMatch + leastBusy
      if (Math.abs(sum - 1.0) > 0.01) {
        throw new Error('Weights must sum to 1.0')
      }

      appPreferenceRepository.set('scheduling.weights', JSON.stringify(weights))
      // Note: weights apply on next execution run (SpecialistPoolService reads at construction)
    }
  )
}
