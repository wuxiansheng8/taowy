import sys
from substrateinterface import SubstrateInterface

def main():
    print("Connecting to Bittensor...")
    endpoint = "wss://entrypoint-finney.opentensor.ai:443"
    try:
        sub = SubstrateInterface(url=endpoint)
        
        # We will test query storage for netuid 1
        netuid = 1
        storage_funcs = [
            "SubnetOwner",
            "SubnetVolume",
            "Tempo",
            "LastStep",
            "SubnetAlphaIn",
            "SubnetAlphaOut",
            "SubnetTaoIn"
        ]
        
        print(f"\nQuerying storage for netuid {netuid}:")
        for func in storage_funcs:
            try:
                val = sub.query("SubtensorModule", func, [netuid])
                print(f"  {func}: {val.value if hasattr(val, 'value') else val}")
            except Exception as e:
                print(f"  {func} failed: {e}")
                
        # Also query NetworkImmunityPeriod and SubnetImmunityPeriod
        print("\nQuerying global parameters:")
        for func in ["NetworkImmunityPeriod", "SubnetImmunityPeriod", "NetworkImmunityPeriodLimit", "LockCost", "ImmunityPeriod"]:
            try:
                if func == "ImmunityPeriod":
                    val = sub.query("SubtensorModule", func, [netuid])
                else:
                    val = sub.query("SubtensorModule", func)
                print(f"  {func}: {val.value if hasattr(val, 'value') else val}")
            except Exception as e:
                print(f"  {func} failed: {e}")
                
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
