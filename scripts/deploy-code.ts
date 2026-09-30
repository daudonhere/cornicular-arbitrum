import { config as dotenvConfig } from "dotenv"
import { ethers, upgrades } from "hardhat"
import * as fs from "fs"
import * as path from "path"

dotenvConfig()

const MARKER_FILE = path.resolve(__dirname, ".deployed-proxy.json")

interface DeployedProxy {
  address: string
  implementation: string
  proxyAdmin: string
  txHash: string
  network: string
  deployedAt: string
  codeDeployedAt?: string
  codeTxHash?: string
  proxyUpgradeTxHash?: string
}

function readMarker(): DeployedProxy | null {
  if (!fs.existsSync(MARKER_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(MARKER_FILE, "utf8")) as DeployedProxy
  } catch {
    return null
  }
}

function writeMarker(data: DeployedProxy) {
  fs.writeFileSync(MARKER_FILE, JSON.stringify(data, null, 2) + "\n")
  console.log("Wrote deployment marker:", MARKER_FILE)
}

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS
  if (!proxyAddress) {
    console.error("Set PROXY_ADDRESS env to the current proxy address.")
    process.exitCode = 1
    return
  }

  const network = await ethers.provider.getNetwork()
  const networkName = network.name === "unknown" ? "localhost" : network.name

  console.log("Deploying code to proxy on:", networkName, "(chainId:", network.chainId + ")")
  console.log("Proxy address:", proxyAddress)
  console.log("")

  const before = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log("Implementation before:", before)

  const factory = await ethers.getContractFactory("CornicularRegistry")
  const deployed = await upgrades.upgradeProxy(proxyAddress, factory, {
    unsafeAllowRenames: true,
    unsafeSkipStorageCheck: true,
  })
  await deployed.waitForDeployment()

  const after = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  const codeTxHash = deployed.deploymentTransaction()?.hash

  console.log("")
  console.log("Code deployed to proxy:", proxyAddress)
  console.log("Implementation after :", after)
  if (codeTxHash) console.log("Deploy tx hash       :", codeTxHash)

  if (before === after) {
    console.log("")
    console.log("NOTE: implementation address did not change.")
    console.log("Deployed bytecode is identical to what was already live.")
  } else {
    console.log("New implementation  :", after)
  }

  const existing = readMarker()
  if (existing) {
    writeMarker({
      ...existing,
      implementation: after,
      codeDeployedAt: new Date().toISOString(),
      codeTxHash: codeTxHash ?? existing.codeTxHash,
      proxyUpgradeTxHash: existing.proxyUpgradeTxHash,
    })
  } else {
    console.log("")
    console.log("No marker file at", MARKER_FILE, "so it was not updated.")
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
