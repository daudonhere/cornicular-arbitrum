import { config as dotenvConfig } from "dotenv"
import { ethers } from "hardhat"

dotenvConfig()

async function main() {
  const [deployer] = await ethers.getSigners()

  const admin = process.env.CONTRACT_ADMIN_ADDRESS || deployer.address
  const initialIssuer =
    process.env.CONTRACT_ISSUER_ADDRESS || deployer.address

  const factory = await ethers.getContractFactory("CornicularRegistry")
  const registry = await factory.deploy(admin, initialIssuer)
  await registry.waitForDeployment()

  const address = await registry.getAddress()
  console.log("CornicularRegistry deployed to:", address)
  console.log("Admin:", admin)
  console.log("Initial issuer:", initialIssuer)
  console.log("Network:", (await ethers.provider.getNetwork()).name)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
