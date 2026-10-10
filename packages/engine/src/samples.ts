/** Reproducible sample workloads. Each one demonstrates a specific systems behaviour. */
export interface Sample { id: string; title: string; topic: string; blurb: string; source: string }

export const SAMPLES: Sample[] = [
  {
    id: 'web-stack',
    title: 'Web stack on two cores',
    topic: 'Overview',
    blurb: 'A web server, a background indexer and a logger sharing two cores, eight frames and a lock. A good first run: every view has something in it.',
    source: `# A small web stack: request handling, a memory-hungry indexer and a logger.
config cores=2 scheduler=rr quantum=4 cs=1 frames=8 replacement=lru tlb=4 fault=6
mutex logLock
shared requests=0

process server priority=2 pages=6
  thread accept
    repeat 4
      load 0x000          # socket buffers
      compute 2
      syscall io 5        # wait for the network
      lock logLock
      inc requests
      unlock logLock
    end
  thread worker arrive=3
    repeat 4
      load 0x200
      store 0x240
      compute 3
      lock logLock
      inc requests
      unlock logLock
    end

process indexer priority=5 pages=8 arrive=1
  repeat 3
    load 0x000
    load 0x100
    load 0x200
    load 0x300
    load 0x400
    store 0x500
    load 0x700
    compute 4
  end

process logger priority=4 arrive=6
  repeat 3
    lock logLock
    compute 2
    unlock logLock
    syscall io 6
  end
`
  },
  {
    id: 'convoy',
    title: 'Convoy effect (FCFS)',
    topic: 'Scheduling',
    blurb: 'One long job arrives first and every short job queues behind it. Switch the scheduler to sjf or rr and compare the average waiting time.',
    source: `# The textbook convoy: try scheduler=sjf, srtf or rr quantum=4.
config scheduler=fcfs

process render
  compute 24
process ping
  compute 3
process pong
  compute 3
process tick
  compute 2
`
  },
  {
    id: 'round-robin',
    title: 'Round robin and switch overhead',
    topic: 'Scheduling',
    blurb: 'Four CPU-bound jobs with a 2-tick context switch. A tiny quantum wastes most of the CPU on switching; try quantum=1, 4 and 12.',
    source: `# Context switches cost 2 ticks here. Watch the grey switch bars on the timeline.
config scheduler=rr quantum=2 cs=2

process A
  compute 12
process B
  compute 12
process C
  compute 8
process D arrive=4
  compute 6
`
  },
  {
    id: 'race-counter',
    title: 'Lost updates on a shared counter',
    topic: 'Synchronization',
    blurb: 'Two threads increment a shared counter 40 times each without a lock. Each inc is load / add / store, and preemption between them loses updates.',
    source: `# Expected: counter = 80. Run it and see what you actually get.
# Fix it with a mutex (lock m / unlock m around inc) or with atomic_inc.
config scheduler=rr quantum=2
shared counter=0

process bank
  thread teller1
    repeat 40
      inc counter
    end
  thread teller2
    repeat 40
      inc counter
    end
`
  },
  {
    id: 'deadlock-abba',
    title: 'ABBA deadlock',
    topic: 'Deadlock',
    blurb: 'Two threads take the same two locks in opposite order. The wait-for graph closes into a cycle; kill a thread from the terminal to recover.',
    source: `# transfer() locks accounts in argument order: a→b in one thread, b→a in the other.
config scheduler=rr quantum=1
mutex acctA acctB

process transfer1
  lock acctA
  compute 2
  lock acctB        # waits for transfer2
  compute 1
  unlock acctB
  unlock acctA

process transfer2
  lock acctB
  compute 2
  lock acctA        # waits for transfer1: cycle
  compute 1
  unlock acctA
  unlock acctB
`
  },
  {
    id: 'philosophers',
    title: 'Dining philosophers',
    topic: 'Deadlock',
    blurb: 'Five philosophers each pick up the left fork, then the right. Everyone holds one fork and waits for the next: a five-thread cycle.',
    source: `# Fix: let one philosopher pick up the right fork first (break the circular wait).
config scheduler=rr quantum=1
mutex f0 f1 f2 f3 f4

process table
  thread p0
    lock f0
    compute 1
    lock f1
    compute 2
    unlock f1
    unlock f0
  thread p1
    lock f1
    compute 1
    lock f2
    compute 2
    unlock f2
    unlock f1
  thread p2
    lock f2
    compute 1
    lock f3
    compute 2
    unlock f3
    unlock f2
  thread p3
    lock f3
    compute 1
    lock f4
    compute 2
    unlock f4
    unlock f3
  thread p4
    lock f4
    compute 1
    lock f0
    compute 2
    unlock f0
    unlock f4
`
  },
  {
    id: 'thrashing',
    title: 'Thrashing',
    topic: 'Virtual memory',
    blurb: 'Three processes each loop over a 5-page working set, but only 8 frames exist. Pages are evicted just before they are needed again.',
    source: `# Working sets: 3 × 5 pages = 15 pages, but frames=8.
# Try frames=16, or a different replacement policy.
config scheduler=rr quantum=3 frames=8 replacement=lru fault=8 tlb=2

process alpha pages=8
  repeat 4
    load 0x000
    load 0x100
    load 0x200
    load 0x300
    load 0x400
    compute 1
  end
process beta pages=8
  repeat 4
    load 0x000
    load 0x100
    load 0x200
    load 0x300
    load 0x400
    compute 1
  end
process gamma pages=8
  repeat 4
    load 0x000
    load 0x100
    load 0x200
    load 0x300
    load 0x400
    compute 1
  end
`
  },
  {
    id: 'priority-inversion',
    title: 'Priority inversion',
    topic: 'Scheduling + locks',
    blurb: 'The Mars Pathfinder bug: a low-priority thread holds a lock the high-priority thread needs, and a medium thread keeps the low one off the CPU. Turn on inherit=true.',
    source: `# Lower number = higher priority. Try inherit=true.
config scheduler=priority preempt=true inherit=false
mutex bus

process meteo priority=9       # low: holds the bus
  lock bus
  compute 5
  unlock bus

process control priority=1 arrive=1   # high: needs the bus
  lock bus
  compute 2
  unlock bus

process comms priority=5 arrive=2     # medium: CPU-bound
  compute 14
`
  },
  {
    id: 'producer-consumer',
    title: 'Producer–consumer with a missing signal',
    topic: 'Synchronization',
    blurb: 'A bounded buffer of two slots. The consumer forgets to signal `empty`, so the producer blocks forever: a stall with no lock cycle. Signal it from the terminal, or fix line 24.',
    source: `# Bounded buffer: empty counts free slots, full counts items.
config scheduler=rr quantum=2
mutex buf
sem empty=2 full=0

process producer
  repeat 5
    compute 1          # make an item
    wait empty
    lock buf
    compute 1          # put it in the buffer
    unlock buf
    signal full
  end

process consumer
  repeat 5
    wait full
    lock buf
    compute 1          # take an item
    unlock buf
    compute 2          # use it
    # BUG: should be \`signal empty\`
  end
`
  },
  {
    id: 'starvation',
    title: 'Starvation and aging',
    topic: 'Scheduling',
    blurb: 'A steady stream of high-priority jobs keeps a low-priority job waiting. Turn on aging=4 so waiting slowly raises its priority.',
    source: `# Try aging=4.
config scheduler=priority preempt=true aging=0 starve=20

process backup priority=9
  compute 4
process req0 priority=2
  compute 5
process req1 priority=2 arrive=4
  compute 5
process req2 priority=2 arrive=9
  compute 5
process req3 priority=2 arrive=14
  compute 5
process req4 priority=2 arrive=19
  compute 5
process req5 priority=2 arrive=24
  compute 5
process req6 priority=2 arrive=29
  compute 5
process req7 priority=2 arrive=34
  compute 5
process req8 priority=2 arrive=39
  compute 5
process req9 priority=2 arrive=44
  compute 5
`
  },
  {
    id: 'segfault',
    title: 'Segmentation fault',
    topic: 'Virtual memory',
    blurb: 'A loop walks off the end of a 4-page buffer and touches page 5. The MMU finds no mapping, the process is killed, and its frames are reclaimed.',
    source: `# pages=4 with pagesize=256 means valid addresses are 0x000-0x3ff.
config scheduler=rr quantum=3 frames=6 pagesize=256

process parser pages=4
  load 0x000
  load 0x100
  load 0x200
  load 0x300
  load 0x500        # past the end
  compute 4

process shell
  compute 3
  syscall io 4
  compute 3
`
  }
];

export function getSample(id: string): Sample | undefined { return SAMPLES.find(s => s.id === id); }
