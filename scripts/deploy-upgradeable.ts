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

async function verifyOnChain(address: string): Promise<DeployedProxy | null> {
  const code = await ethers.provider.getCode(address)
  if (code === "0x") return null
  const implementation = await upgrades.erc1967.getImplementationAddress(address)
  const proxyAdmin = await upgrades.erc1967.getAdminAddress(address)
  if (implementation === ethers.ZeroAddress) return null
  return {
    address,
    implementation,
    proxyAdmin,
    txHash: "0x" + "0".repeat(64),
    network: (await ethers.provider.getNetwork()).name,
    deployedAt: new Date().toISOString(),
  }
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const admin = process.env.CONTRACT_ADMIN_ADDRESS || deployer.address
  const initialIssuer =
    process.env.CONTRACT_ISSUER_ADDRESS || deployer.address
  const networkName = (await ethers.provider.getNetwork()).name

  const existing = readMarker()
  if (existing) {
    const onChain = await verifyOnChain(existing.address)
    if (onChain) {
      console.log("Proxy already deployed and valid on-chain.")
      console.log("Proxy:", onChain.address)
      console.log("Implementation:", onChain.implementation)
      console.log("Proxy admin:", onChain.proxyAdmin)
      return
    }
    console.log("Marker found but on-chain contract is gone. Redeploying.")
  }

  const factory = await ethers.getContractFactory("CornicularRegistry")

  let proxyAddress: string | null = null
  let proxyAdminAddress: string | null = null

  try {
    const proxy = await upgrades.deployProxy(
      factory,
      [admin, initialIssuer],
      { kind: "transparent" }
    )
    await proxy.waitForDeployment()
    proxyAddress = await proxy.getAddress()
  } catch (err: any) {
    const reason = err?.reason || err?.message || String(err)
    console.log(
      "Ignoring post-deploy validation notice from hardhat-upgrades:"
    )
    console.log("  " + reason.slice(0, 300))
  }

  if (!proxyAddress) {
    console.error("Unable to resolve a deployed proxy address.")
    process.exitCode = 1
    return
  }

  const chain = await verifyOnChain(proxyAddress)
  if (!chain) {
    console.error("Deployed contract is not a valid ERC-1967 proxy.")
    process.exitCode = 1
    return
  }
  if (proxyAdminAddress) chain.proxyAdmin = proxyAdminAddress

  console.log("CornicularRegistry proxy:", chain.address)
  console.log("Implementation:", chain.implementation)
  console.log("Proxy admin:", chain.proxyAdmin)
  console.log("Admin role account:", admin)
  console.log("Initial issuer:", initialIssuer)
  console.log("Network:", networkName)
  console.log("")

  const envKey =
    networkName === "base" || networkName === "mainnet"
      ? "CHAIN_CONTRACT_MAINNET"
      : "CHAIN_CONTRACT_TESTNET"
  console.log("Update backend .env: " + envKey + "=" + chain.address)

  writeMarker(chain)
}

main().catch((error) => {
  console.error("Deployment failed:", error?.message || error)
  process.exitCode = 1
})
