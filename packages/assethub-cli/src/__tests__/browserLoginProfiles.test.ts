import {describe, expect, it} from 'vitest'

import {
  assignWorkspaceProfileNames,
  workspaceProfileName,
} from '../browserLoginProfiles.js'

describe('workspaceProfileName', () => {
  it('slugs the name and appends the id prefix', () => {
    expect(
      workspaceProfileName({id: '1A2b3c4d-9999', name: 'My  Studio!'}),
    ).toBe('ws-my-studio-1a2b3c4d')
  })
  it('strips accents and drops emoji/CJK', () => {
    expect(workspaceProfileName({id: 'abcdef12', name: 'Café Ünï'})).toBe(
      'ws-cafe-uni-abcdef12',
    )
    expect(workspaceProfileName({id: 'abcdef12', name: '🚀 スタジオ'})).toBe(
      'ws-abcdef12',
    )
  })
  it('caps the slug at 32 chars without a trailing dash', () => {
    const name = `${'a'.repeat(31)} bbbb`
    expect(workspaceProfileName({id: 'abcdef12', name})).toBe(
      `ws-${'a'.repeat(31)}-abcdef12`,
    )
  })
  it('is stable for the same workspace', () => {
    const w = {id: '0f0f0f0f-1', name: 'Studio'}
    expect(workspaceProfileName(w)).toBe(workspaceProfileName({...w}))
  })
})

describe('assignWorkspaceProfileNames', () => {
  it('suffixes collisions within one login', () => {
    const ws = [
      {id: 'aaaaaaaa1', name: 'X'},
      {id: 'aaaaaaaa2', name: 'X'},
      {id: 'aaaaaaaa3', name: 'X'},
    ]
    expect(assignWorkspaceProfileNames(ws)).toEqual([
      'ws-x-aaaaaaaa',
      'ws-x-aaaaaaaa-2',
      'ws-x-aaaaaaaa-3',
    ])
  })
  it('uses an explicit name for the first workspace only', () => {
    const ws = [
      {id: 'aaaaaaaa1', name: 'A'},
      {id: 'bbbbbbbb1', name: 'B'},
    ]
    expect(assignWorkspaceProfileNames(ws, 'mine')).toEqual([
      'mine',
      'ws-b-bbbbbbbb',
    ])
  })
})
