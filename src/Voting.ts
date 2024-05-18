import {
    AccountUpdate,
    Field,
    MerkleTree,
    MerkleWitness,
    method,
    Mina,
    Poseidon,
    PublicKey,
    SmartContract,
    State,
    state,
    Struct,
    UInt32,
} from 'o1js';

const doProofs = true;

class MyMerkleWitness extends MerkleWitness(8) {}

class Voter extends Struct({
    publicKey: PublicKey,
    decision: UInt32,
}) {
    hash(): Field {
        return Poseidon.hash(Voter.toFields(this));
    }

    setDecision(decision: UInt32) {
        return new Voter({
            publicKey: this.publicKey,
            decision: decision,
        });
    }
}
// we need the initiate tree root in order to tell the contract about our off-chain storage
let initialRoot: Field = Field(0);
/*
  We want to write a smart contract that serves as a leaderboard,
  but only has the commitment of the off-chain storage stored in an on-chain variable.
  The accounts of all participants will be stored off-chain!
  If a participant can guess the preimage of a hash, they will be granted one point :)
*/

class Voting extends SmartContract {
    // a commitment is a cryptographic primitive that allows us to commit to data, with the ability to "reveal" it later
    @state(Field) root = State<Field>();
    @state(UInt32) agreeVotes = State<UInt32>();
    @state(UInt32) disagreeVotes = State<UInt32>();
    @state(Field) title = State<Field>();
    @state(Field) description = State<Field>();

    @method async init() {
        super.init();
        this.root.set(initialRoot);
        this.agreeVotes.set(UInt32.from(0))
        this.disagreeVotes.set(UInt32.from(0))
    }

    @method
    async vote(voter: Voter, decision: UInt32 , path: MyMerkleWitness) {
        // we fetch the on-chain root
        let root = this.root.get();
        this.root.requireEquals(root);

        voter = voter.setDecision(UInt32.from(0))

        // we check that the account is within the committed Merkle Tree
        // And that the decision is not 0
        decision.assertGreaterThan(UInt32.from(0))
        decision.assertLessThan(UInt32.from(3))
        path.calculateRoot(voter.hash()).assertEquals(root);

        let newVoter = voter.setDecision(decision);

        // we calculate the new Merkle Root, based on the account changes
        let newRoot = path.calculateRoot(newVoter.hash());

        if (decision === UInt32.from(1)){
            this.agreeVotes.requireEquals(this.agreeVotes.get());
            let currentAgreeVotes = this.agreeVotes.get()
            this.agreeVotes.set(currentAgreeVotes.add(1))
        } else {
            this.disagreeVotes.requireEquals(this.disagreeVotes.get());
            let currentDisagreeVotes = this.disagreeVotes.get()
            this.agreeVotes.set(currentDisagreeVotes.add(1))
        }
        this.root.set(newRoot);
    }
}

type Names = 'Bob' | 'Alice' | 'Charlie' | 'Olivia';

let Local = await Mina.LocalBlockchain({ proofsEnabled: doProofs });
Mina.setActiveInstance(Local);
let initialBalance = 10_000_000_000;

let [feePayer] = Local.testAccounts;

let contractAccount = Mina.TestPublicKey.random();

// this map serves as our off-chain in-memory storage
let Voters: Map<string, Voter> = new Map<Names, Voter>(
    ['Bob', 'Alice', 'Charlie', 'Olivia'].map((name: string, index: number) => {
        return [
            name as Names,
            new Voter({
                publicKey: Local.testAccounts[index + 1], // `+ 1` is to avoid reusing the account aliased as `feePayer`
                decision: UInt32.from(0),
            }),
        ];
    })
);

// we now need "wrap" the Merkle tree around our off-chain storage
// we initialize a new Merkle Tree with height 8
const Tree = new MerkleTree(8);

Tree.setLeaf(0n, Voters.get('Bob')!.hash());
Tree.setLeaf(1n, Voters.get('Alice')!.hash());
Tree.setLeaf(2n, Voters.get('Charlie')!.hash());
Tree.setLeaf(3n, Voters.get('Olivia')!.hash());

// now that we got our accounts set up, we need the commitment to deploy our contract!
initialRoot = Tree.getRoot();

let contract = new Voting(contractAccount);
console.log('Deploying voting..');

if (doProofs) {
    await Voting.compile();
}
let tx = await Mina.transaction(feePayer, async () => {
    AccountUpdate.fundNewAccount(feePayer).send({
        to: contractAccount,
        amount: initialBalance,
    });
    await contract.deploy();
});
await tx.prove();
await tx.sign([feePayer.key, contractAccount.key]).send();

console.log('Initial decision state: ' + Voters.get('Bob')?.decision);

console.log('Voting..');
await vote('Bob', 0n, UInt32.from(1));

console.log('Final decision: ' + Voters.get('Bob')?.decision);
console.log('All agree decisions: ', contract.agreeVotes.get().toJSON())
console.log('All disagree decisions: ', contract.disagreeVotes.get().toJSON())

async function vote(name: Names, index: bigint, decision: UInt32) {
    let voter = Voters.get(name)!;
    let w = Tree.getWitness(index);
    let witness = new MyMerkleWitness(w);

    let tx = await Mina.transaction(feePayer, async () => {
        await contract.vote(voter, decision, witness);
    });
    await tx.prove();
    await tx.sign([feePayer.key, contractAccount.key]).send();

    // if the transaction was successful, we can update our off-chain storage as well
    voter = voter.setDecision(decision)
    Voters = Voters.set('Bob', voter)
    Tree.setLeaf(index, voter.hash());
    contract.root.get().assertEquals(Tree.getRoot());
}