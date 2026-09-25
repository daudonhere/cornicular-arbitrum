import { config as dotenvConfig } from "dotenv"
import { ethers, upgrades } from "hardhat"

dotenvConfig()

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS
  if (!proxyAddress) {
    console.error("Set PROXY_ADDRESS env to the current proxy address.")
    process.exitCode = 1
    return
  }

  const network = await ethers.provider.getNetwork()
  const networkName = network.name === "unknown" ? "localhost" : network.name

  console.log("Upgrading proxy on:", networkName, "(chainId:", network.chainId + ")")
  console.log("Proxy address:", proxyAddress)
  console.log("")

  const factory = await ethers.getContractFactory("CornicularRegistry")
  const upgraded = await upgrades.upgradeProxy(proxyAddress, factory)
  await upgraded.waitForDeployment()

  const implementationAddress =
    await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log("Proxy upgraded:", proxyAddress)
  console.log("New implementation:", implementationAddress)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
