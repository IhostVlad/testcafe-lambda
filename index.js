const fetch = require('isomorphic-fetch')
const childProcess = require('child_process')
const chromium = require('chrome-aws-lambda')
const createTestCafe = require('testcafe')
const stream = require('stream')
const path = require('path')
const fs = require('fs')

const createTempFile = async (prefix, postfix) => {
  const randFileName = `${prefix}-${Date.now()}${Math.floor(
    Math.random() * 1000000000000
  )}${postfix}`
  const randFilePath = path.join('/tmp', randFileName)
  fs.writeFileSync(randFilePath, '')

  return randFilePath
}

const fetchTestFiles = async originalTestFilesPaths => {
  const result = []
  for (const testFilePath of [].concat(originalTestFilesPaths)) {
    try {
      if (fs.existsSync(testFilePath)) {
        result.push(testFilePath)
        continue
      }
    } catch (error) {}

    try {
      const fullTestFilePath = path.join(process.cwd(), testFilePath)
      if (fs.existsSync(fullTestFilePath)) {
        result.push(fullTestFilePath)
        continue
      }
    } catch (error) {}

    try {
      const content = await (await fetch(testFilePath)).text()
      const tmpFile = await createTempFile(
        testFilePath.replace(/[^A-Za-z0-9-]+/gi, '-'),
        '.js'
      )
      fs.writeFileSync(tmpFile, content)
      result.push(tmpFile)
      continue
    } catch (error) {}

    console.warn('Test file', testFilePath, 'is unresolved, skipping...')
  }

  return result
}

const worker = async originalTestFilesPaths => {
  let testcafe = null,
    browser = null
  try {
    const testFilesPaths = await fetchTestFiles(originalTestFilesPaths)
    testcafe = await createTestCafe('localhost', 1337, 1338)
    const remoteConnection = await testcafe.createBrowserConnection()
    console.log('Testcafe server launched at', remoteConnection.url)

    const connectionDonePromise = new Promise(resolve =>
      remoteConnection.once('ready', resolve)
    )

    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless
    })

    console.log('Headless browser launched as', await browser.userAgent())

    await (await browser.newPage()).goto(remoteConnection.url)
    console.log('Testcafe server accepted connection from headless browser')

    const reportResults = {}
    for (const testFilePath of testFilesPaths) {
      reportResults[testFilePath] = null
    }

    for (const testFilePath of testFilesPaths) {
      console.log('Running functional tests for', testFilePath)
      const failedCount = await testcafe
        .createRunner()
        .reporter([
          'spec',
          {
            name: 'json',
            output: new stream.Writable({
              write(chunk, _, next) {
                reportResults[testFilePath] = Buffer.concat([
                  reportResults[testFilePath] != null
                    ? reportResults[testFilePath]
                    : Buffer.from(''),
                  chunk
                ])
                next()
              }
            })
          }
        ])
        .src(testFilePath)
        .browsers(remoteConnection)
        .run()

      reportResults[testFilePath] =
        reportResults[testFilePath] != null
          ? JSON.parse(reportResults[testFilePath])
          : 'Not passed'

      console.log('Failed functional tests for', testFilePath, ':', failedCount)
    }

    return reportResults
  } catch (error) {
    console.error('Unhandled exception ', error)

    return new Error(error)
  } finally {
    if (testcafe != null) {
      await testcafe.close()
    }

    if (browser != null) {
      await browser.close()
    }
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false
  if (event == null || event.queryStringParameters == null) {
    throw new Error(
      'Missing querystring parameters, ' +
        'ensure launch from API gateway proxy integration'
    )
  }

  const token = process.env.API_TOKEN
  if (!token || event.queryStringParameters.token !== token) {
    return {
      statusCode: 403,
      body: JSON.stringify('Token is invalid')
    }
  }

  const testFilesPaths = event.queryStringParameters.testFilesPaths
  const result = await worker(testFilesPaths)

  return {
    statusCode: result instanceof Error ? 408 : 200,
    body: JSON.stringify(result)
  }
}

if (module.parent == null) {
  ;(async () => {
    const testFilesPaths = process.argv.slice(2)
    const result = await worker(testFilesPaths)
    console.log(JSON.stringify(result, null, 2))
    process.exit(result instanceof Error ? 1 : 0)
  })()
}
