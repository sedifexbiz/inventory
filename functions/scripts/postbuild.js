const fs = require('fs')
const path = require('path')

const libDir = path.join(__dirname, '..', 'lib')
const compiledFunctionsDir = path.join(libDir, 'functions', 'src')

function copyRecursive(source, destination) {
  if (!fs.existsSync(source)) {
    return
  }
  fs.mkdirSync(destination, { recursive: true })
  const entries = fs.readdirSync(source, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const destPath = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      copyRecursive(sourcePath, destPath)
    } else {
      fs.copyFileSync(sourcePath, destPath)
    }
  }
}

copyRecursive(compiledFunctionsDir, libDir)

const compiledFunctionsRoot = path.join(libDir, 'functions')
if (fs.existsSync(compiledFunctionsRoot)) {
  fs.rmSync(compiledFunctionsRoot, { recursive: true, force: true })
}

const compiledSharedDir = path.join(libDir, 'shared')
const sharedDestination = path.join(__dirname, '..', '..', 'shared')
copyRecursive(compiledSharedDir, sharedDestination)
