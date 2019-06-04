fixture`ResolveJS`.page`https://github.com/reimagined/resolve`

test('ResolveJS', async t => {
  await t.setNativeDialogHandler(() => true)
  const locationPath = (await t.eval(() => window.location)).pathname
  await t.expect(locationPath).eql('/reimagined/resolve')
  // await t.expect(locationPath).eql('/reimagined/resolve2')
})
