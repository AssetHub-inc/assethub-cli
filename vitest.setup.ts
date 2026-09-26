import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll} from 'vitest'

// Every CLI process the tests spawn inherits this, so no test can write MCP
// configuration or agent skills into the developer's real home directory.
const home = mkdtempSync(join(tmpdir(), 'assethub-test-home-'))
process.env.ASSETHUB_CLI_HOME = home
afterAll(() => rmSync(home, {recursive: true, force: true}))
