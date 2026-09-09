import {describe, expect, it, vi} from 'vitest'
import {createServer, type Server} from 'node:http'
import {once} from 'node:events'

import {
  WorkspaceClientError,
  createWorkspaceClient,
} from '../../../assethub-api-client/src/workspaces.js'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  })

const listen = async (server: Server): Promise<number> => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('No port')
  return address.port
}

const close = async (server: Server): Promise<void> => {
  server.close()
  await once(server, 'close')
}

describe('workspace client', () => {
  it('manages members with user authentication and preserves server rejections', async () => {
    const member = {userId: 'user-2', email: 'member@example.com', name: 'Member', role: 'user'}
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({workspaceId: 'workspace-1', members: [member]}))
      .mockResolvedValueOnce(json({workspaceId: 'workspace-1', ...member, status: 'invited'}))
      .mockResolvedValueOnce(json({workspaceId: 'workspace-1', userId: 'user-2', role: 'admin', updated: true}))
      .mockResolvedValueOnce(json({workspaceId: 'workspace-1', userId: 'user-2', removed: true}))
      .mockResolvedValueOnce(json({error: {code: 'MEMBER_OPERATION_REJECTED', message: 'Last admin'}}, 409))
    const client = createWorkspaceClient({accessToken: 'user-token', workspaceMfaToken: 'proof', fetch: request})
    expect(await client.listMembers('workspace-1')).toEqual({workspaceId: 'workspace-1', members: [member]})
    expect(await client.inviteMember('workspace-1', {email: member.email, role: 'user'})).toMatchObject({status: 'invited'})
    expect(await client.setMemberRole('workspace-1', {userId: member.userId, role: 'admin'})).toMatchObject({updated: true})
    expect(await client.removeMember('workspace-1', member.userId)).toMatchObject({removed: true})
    await expect(client.removeMember('workspace-1', member.userId)).rejects.toMatchObject({status: 409, code: 'MEMBER_OPERATION_REJECTED'})
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'PATCH', 'DELETE', 'DELETE'])
    for (const [url, init] of request.mock.calls) {
      expect(String(url)).toBe('https://app.assethub.io/api/workspaces/workspace-1/members')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer user-token')
      expect(new Headers(init?.headers).get('Cookie')).toBe('ah_workspace_mfa=proof')
    }
  })

  it('lists workspaces with the user bearer token', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        userId: 'user-1',
        workspaces: [
          {
            id: 'workspace-1',
            name: 'Studio',
            type: 'team',
            role: 'admin',
            active: true,
          },
        ],
      }),
    )
    const client = createWorkspaceClient({
      accessToken: 'user-access-token',
      baseUrl: 'https://app.example.test/',
      fetch: request,
    })

    await expect(client.list()).resolves.toEqual({
      userId: 'user-1',
      workspaces: [
        {
          id: 'workspace-1',
          name: 'Studio',
          type: 'team',
          role: 'admin',
          active: true,
        },
      ],
    })
    const [url, init] = request.mock.calls[0]
    expect(String(url)).toBe('https://app.example.test/api/workspaces')
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer user-access-token',
    )
  })

  it('accepts legacy owner memberships returned by the workspace API', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        userId: 'user-1',
        workspaces: [
          {
            id: 'workspace-legacy',
            name: 'Legacy Studio',
            type: null,
            role: 'owner',
            active: false,
          },
        ],
      }),
    )
    const client = createWorkspaceClient({
      accessToken: 'user-access-token',
      fetch: request,
    })

    await expect(client.list()).resolves.toMatchObject({
      workspaces: [{id: 'workspace-legacy', role: 'owner', type: null}],
    })
  })

  it('creates a workspace with its JSON body and stable UUID idempotency key', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          workspace: {id: 'workspace-2', name: 'Characters'},
          created: true,
        },
        201,
      ),
    )
    const client = createWorkspaceClient({
      accessToken: 'token',
      fetch: request,
    })
    const idempotencyKey = '11111111-1111-4111-8111-111111111111'

    await expect(
      client.create({name: 'Characters'}, {idempotencyKey}),
    ).resolves.toEqual({
      workspace: {id: 'workspace-2', name: 'Characters'},
      created: true,
    })
    const [url, init] = request.mock.calls[0]
    expect(String(url)).toBe('https://app.assethub.io/api/workspaces')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
      idempotencyKey,
    )
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/json',
    )
    expect(init?.body).toBe(JSON.stringify({name: 'Characters'}))
  })

  it('selects a workspace and returns its MFA requirement', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        workspaceId: 'workspace-1',
        selected: true,
        mfa: {
          status: 'verify_required',
          factorId: 'factor-1',
          factorType: 'totp',
        },
      }),
    )
    const client = createWorkspaceClient({
      accessToken: 'token',
      workspaceMfaToken: 'signed/proof.value',
      fetch: request,
    })

    await client.select('workspace-1')

    const [url, init] = request.mock.calls[0]
    expect(String(url)).toBe('https://app.assethub.io/api/workspaces/select')
    expect(init?.body).toBe(JSON.stringify({workspaceId: 'workspace-1'}))
    expect(new Headers(init?.headers).get('Cookie')).toBe(
      'ah_workspace_mfa=signed%2Fproof.value',
    )
  })

  it('creates an API key under the encoded workspace path', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          apiKey: {
            id: 'key-1',
            name: 'CLI',
            lastFour: '1234',
            workspaceId: 'workspace/a',
            key: 'ah_live_secret',
          },
        },
        201,
      ),
    )
    const client = createWorkspaceClient({accessToken: 'token', fetch: request})

    await expect(
      client.createApiKey('workspace/a', {name: 'CLI'}),
    ).resolves.toMatchObject({id: 'key-1', key: 'ah_live_secret'})
    const [url, init] = request.mock.calls[0]
    expect(String(url)).toBe(
      'https://app.assethub.io/api/workspaces/workspace%2Fa/api-keys',
    )
    expect(init?.body).toBe(JSON.stringify({name: 'CLI'}))
  })

  it('throws typed HTTP errors without leaking the access token', async () => {
    const accessToken = 'sensitive-user-token'
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `Denied bearer ${accessToken}`,
          },
        },
        403,
      ),
    )
    const client = createWorkspaceClient({accessToken, fetch: request})

    const error = await client.list().catch(value => value)

    expect(error).toBeInstanceOf(WorkspaceClientError)
    expect(error).toMatchObject({status: 403, code: 'FORBIDDEN'})
    expect(error.message).not.toContain(accessToken)
  })

  it('redacts the workspace MFA proof from HTTP and network errors', async () => {
    const workspaceMfaToken = 'private/signed.mfa-proof'
    const encodedMfaToken = encodeURIComponent(workspaceMfaToken)
    const httpRequest = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          error: {
            code: 'MFA_REQUIRED',
            message: `Rejected ${workspaceMfaToken} (${encodedMfaToken})`,
          },
        },
        403,
      ),
    )
    const httpClient = createWorkspaceClient({
      accessToken: 'token',
      workspaceMfaToken,
      fetch: httpRequest,
    })

    const httpError = await httpClient.list().catch(value => value)

    expect(httpError.message).not.toContain(workspaceMfaToken)
    expect(httpError.message).not.toContain(encodedMfaToken)

    const networkRequest = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`Failed cookie ${encodedMfaToken}`))
    const networkClient = createWorkspaceClient({
      accessToken: 'token',
      workspaceMfaToken,
      fetch: networkRequest,
    })

    const networkError = await networkClient.list().catch(value => value)

    expect(networkError).toMatchObject({status: 0, code: 'NETWORK_ERROR'})
    expect(networkError.message).not.toContain(workspaceMfaToken)
    expect(networkError.message).not.toContain(encodedMfaToken)
  })

  it('rejects credential-bearing and insecure remote base URLs', () => {
    expect(() =>
      createWorkspaceClient({
        accessToken: 'token',
        baseUrl: 'https://user:password@app.example.test',
      }),
    ).toThrow('Workspace API base URL cannot include credentials')
    expect(() =>
      createWorkspaceClient({
        accessToken: 'token',
        baseUrl: 'http://app.example.test',
      }),
    ).toThrow('Workspace API base URL must use HTTPS')
  })

  it('allows HTTP for a loopback development server', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({userId: 'user-1', workspaces: []}))
    const client = createWorkspaceClient({
      accessToken: 'token',
      baseUrl: 'http://127.0.0.1:3000',
      fetch: request,
    })

    await client.list()

    expect(String(request.mock.calls[0][0])).toBe(
      'http://127.0.0.1:3000/api/workspaces',
    )
  })

  it('does not follow a redirect with the bearer token', async () => {
    let redirectedAuthorization: string | undefined
    const destination = createServer((request, response) => {
      redirectedAuthorization = request.headers.authorization
      response.end('{}')
    })
    const destinationPort = await listen(destination)
    const source = createServer((_request, response) => {
      response.writeHead(302, {
        Location: `http://127.0.0.1:${destinationPort}/capture`,
      })
      response.end()
    })
    const sourcePort = await listen(source)
    try {
      const client = createWorkspaceClient({
        accessToken: 'redirect-secret',
        baseUrl: `http://127.0.0.1:${sourcePort}`,
      })

      const error = await client.list().catch(value => value)

      expect(error).toBeInstanceOf(WorkspaceClientError)
      expect(error).toMatchObject({status: 0, code: 'NETWORK_ERROR'})
      expect(redirectedAuthorization).toBeUndefined()
    } finally {
      await Promise.all([close(source), close(destination)])
    }
  })

  it.each([
    {
      name: 'workspace list without a verified user',
      response: {workspaces: []},
      run: (client: ReturnType<typeof createWorkspaceClient>) => client.list(),
    },
    {
      name: 'workspace creation with an invalid id',
      response: {workspace: {id: '', name: 'Studio'}, created: true},
      run: (client: ReturnType<typeof createWorkspaceClient>) =>
        client.create(
          {name: 'Studio'},
          {idempotencyKey: '11111111-1111-4111-8111-111111111111'},
        ),
    },
    {
      name: 'selection with an unknown MFA state',
      response: {
        workspaceId: 'workspace-1',
        selected: true,
        mfa: {status: 'maybe'},
      },
      run: (client: ReturnType<typeof createWorkspaceClient>) =>
        client.select('workspace-1'),
    },
    {
      name: 'API key creation without its one-time raw key',
      response: {
        apiKey: {
          id: 'key-1',
          name: 'CLI',
          lastFour: '1234',
          workspaceId: 'workspace-1',
        },
      },
      run: (client: ReturnType<typeof createWorkspaceClient>) =>
        client.createApiKey('workspace-1', {name: 'CLI'}),
    },
  ])('rejects malformed 2xx: $name', async ({response, run}) => {
    const token = 'sensitive-token'
    const request = vi.fn<typeof fetch>().mockResolvedValue(json(response))
    const client = createWorkspaceClient({accessToken: token, fetch: request})

    const error = await run(client).catch(value => value)

    expect(error).toBeInstanceOf(WorkspaceClientError)
    expect(error).toMatchObject({status: 200, code: 'INVALID_RESPONSE'})
    expect(error.message).toBe('Workspace API returned an invalid response')
    expect(error.message).not.toContain(token)
    expect(error).not.toHaveProperty('payload')
  })
})
