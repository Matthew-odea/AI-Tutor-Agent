import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above this file's top-level code, so the mock fn must be too.
const { loadPyodideMock } = vi.hoisted(() => ({ loadPyodideMock: vi.fn() }))

vi.mock('pyodide', () => ({
  loadPyodide: loadPyodideMock,
}))

import { getPyodide, isPyodideLoaded, resetPyodide } from './pyodideLoader'

describe('pyodideLoader', () => {
  beforeEach(() => {
    loadPyodideMock.mockReset()
    resetPyodide()
  })

  it('caches loaded Pyodide instance', async () => {
    const mockInstance = { runPythonAsync: vi.fn() }
    loadPyodideMock.mockResolvedValue(mockInstance)

    const first = await getPyodide()
    const second = await getPyodide()

    expect(first).toBe(mockInstance)
    expect(second).toBe(mockInstance)
    expect(loadPyodideMock).toHaveBeenCalledTimes(1)
    expect(isPyodideLoaded()).toBe(true)
  })

  it('allows retry after failed initial load', async () => {
    const mockInstance = { runPythonAsync: vi.fn() }
    loadPyodideMock
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(mockInstance)

    await expect(getPyodide()).rejects.toThrow('Network error')
    expect(isPyodideLoaded()).toBe(false)

    await expect(getPyodide()).resolves.toBe(mockInstance)
    expect(loadPyodideMock).toHaveBeenCalledTimes(2)
    expect(isPyodideLoaded()).toBe(true)
  })
})
