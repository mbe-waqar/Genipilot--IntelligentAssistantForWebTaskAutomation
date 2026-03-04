# FYP Auto - Complete Agent Architecture (Fixed - Single Image)

## 🤖 Complete Agent-Focused System Architecture

This is a **single comprehensive diagram** showing the entire system with focus on agent orchestration.

```mermaid
flowchart TB
    %% User Layer
    User([User])
    Extension[Chrome Extension Sidebar Chat]
    Dashboard[Web Dashboard Task Management]

    %% Gateway
    WebSocket[WebSocket Handler Port 5005]
    RestAPI[REST API Port 8000]

    %% Orchestrator Agent - THE CORE
    OrcInput[Receive User Message]
    LoadSession[Load Conversation from MongoDB]

    Analyze{Orchestrator Agent GPT-4.1-mini Does this need browser automation?}

    DirectResponse[Generate Direct Response NO TOOL NEEDED]

    CallTool[Call Automation Tool TOOL REQUIRED]

    %% Browser Automation
    AutoStart[execute_automation_task]
    CreateHistory[Create AutomationHistory status running]
    CreateAgent[Create Browser Agent browser-use library]

    AgentPlan[Browser Agent Plans Steps GPT-4o-mini]
    AgentExecute[Execute Action navigate click type extract]

    CheckHITL{Need User Input?}
    AskHuman[ask_human tool Request info from user]
    Wait2FA[wait_for_2fa tool Pause for 2FA]
    CheckCancel{User Cancelled?}

    Chrome[Chrome Browser CDP Port 9222]

    TaskDone{Task Complete?}
    ReturnResult[Return Result String]

    %% Response
    SaveSession[Save Conversation to MongoDB]
    StreamResponse[Stream to User]

    %% Database
    MongoDB[(MongoDB users automation_history scheduled_tasks agent_sessions)]

    %% Scheduler
    Scheduler[APScheduler Scheduled Tasks]

    %% Connections
    User --> Extension
    User --> Dashboard

    Extension --> WebSocket
    Dashboard --> RestAPI

    WebSocket --> OrcInput
    RestAPI --> MongoDB

    OrcInput --> LoadSession
    LoadSession --> MongoDB
    LoadSession --> Analyze

    %% Decision Point
    Analyze -->|NO| DirectResponse
    Analyze -->|YES| CallTool

    %% Direct path
    DirectResponse --> SaveSession

    %% Tool calling path
    CallTool --> AutoStart
    AutoStart --> CreateHistory
    CreateHistory --> MongoDB
    AutoStart --> CreateAgent
    CreateAgent --> AgentPlan

    %% Browser agent loop
    AgentPlan --> AgentExecute
    AgentExecute --> Chrome
    Chrome --> TaskDone

    TaskDone -->|No| CheckHITL
    TaskDone -->|Yes| ReturnResult

    %% HITL flow
    CheckHITL -->|Ask for info| AskHuman
    CheckHITL -->|Need 2FA| Wait2FA
    CheckHITL -->|Check cancel| CheckCancel
    CheckHITL -->|No input needed| AgentPlan

    AskHuman --> WebSocket
    WebSocket -.->|User responds| AskHuman
    AskHuman --> AgentPlan

    Wait2FA --> WebSocket
    WebSocket -.->|User completes| Wait2FA
    Wait2FA --> AgentPlan

    CheckCancel -->|Yes| ReturnResult
    CheckCancel -->|No| AgentPlan

    %% Return to orchestrator
    ReturnResult --> MongoDB
    ReturnResult --> CallTool
    CallTool --> SaveSession

    %% Final response
    SaveSession --> MongoDB
    SaveSession --> StreamResponse
    StreamResponse --> WebSocket
    WebSocket --> Extension
    Extension --> User

    %% Scheduler
    Dashboard -.->|Create task| RestAPI
    RestAPI -.->|Save| MongoDB
    MongoDB -.->|Load tasks| Scheduler
    Scheduler -.->|Trigger| AutoStart

    %% Styling
    classDef userClass fill:#e3f2fd,stroke:#1976d2,stroke-width:3px
    classDef agentClass fill:#f3e5f5,stroke:#7b1fa2,stroke-width:4px
    classDef decisionClass fill:#fff9c4,stroke:#f57c00,stroke-width:3px
    classDef toolClass fill:#ffe0b2,stroke:#e65100,stroke-width:2px
    classDef browserClass fill:#c8e6c9,stroke:#388e3c,stroke-width:2px
    classDef hitlClass fill:#ffccbc,stroke:#d84315,stroke-width:2px
    classDef dbClass fill:#ffcdd2,stroke:#c62828,stroke-width:3px

    class User,Extension,Dashboard userClass
    class Analyze,OrcInput,DirectResponse,CallTool,SaveSession,StreamResponse agentClass
    class CheckHITL,TaskDone,CheckCancel decisionClass
    class AutoStart,CreateAgent,AgentPlan,AgentExecute toolClass
    class Chrome,ReturnResult browserClass
    class AskHuman,Wait2FA hitlClass
    class MongoDB,Scheduler dbClass
```

---

## 🔑 Key Points Explained

### 1️⃣ **Orchestrator Agent Decision Point**

The **Orchestrator Agent (GPT-4.1-mini)** is the brain that decides:

- **NO TOOL NEEDED** → Direct conversational response

  - Example: "What is AI?" → GPT-4 answers directly
  - Example: "Tell me a joke" → GPT-4 generates joke
- **TOOL REQUIRED** → Calls Automation Tool

  - Example: "Go to Amazon" → Calls browser automation
  - Example: "Search Google for AI" → Calls browser automation

### 2️⃣ **Browser Agent Execution**

When automation is needed:

1. Creates **Browser Agent** (browser-use library)
2. Agent **plans steps** using GPT-4o-mini
3. **Executes actions** in Chrome via CDP
4. **Checks if user input needed** (HITL)
5. **Returns result** to Orchestrator

### 3️⃣ **Human-in-the-Loop (HITL)**

During automation, the browser agent can:

- **ask_human**: Request missing information

  - "What is your email?"
  - User responds via modal → Agent continues
- **wait_for_2fa**: Pause for 2FA

  - User completes 2FA in browser
  - Clicks "Done" → Agent continues
- **Check cancellation**: User can stop anytime

  - User clicks "Stop" button
  - Agent stops and returns

---

## 📊 Example Flow: "Go to Amazon and find cheapest laptop"

```mermaid
sequenceDiagram
    participant U as User
    participant O as Orchestrator Agent<br/>(GPT-4.1-mini)
    participant T as Automation Tool
    participant B as Browser Agent<br/>(browser-use)
    participant C as Chrome Browser

    U->>O: "Go to Amazon and find cheapest laptop"

    rect rgb(240, 240, 255)
    Note over O: Orchestrator Analyzes
    O->>O: This needs browser automation
    O->>O: Decision: CALL TOOL
    end

    O->>T: Automation("find cheapest laptop on Amazon")
    T->>B: Create browser agent

    rect rgb(240, 255, 240)
    Note over B,C: Browser Automation
    B->>C: Navigate to amazon.com
    B->>C: Search for "laptop"
    B->>C: Sort by price (low to high)
    B->>C: Extract cheapest laptop
    end

    C-->>B: Product data
    B-->>T: "Lenovo ThinkPad - $299"
    T-->>O: Return result

    rect rgb(255, 240, 240)
    Note over O: Generate Response
    O->>O: "I found the cheapest laptop..."
    end

    O-->>U: "The cheapest laptop on Amazon is<br/>Lenovo ThinkPad for $299"
```

---

## 🎯 Comparison: Tool vs No Tool

```mermaid
flowchart LR
    subgraph NoTool[" NO TOOL SCENARIO "]
        U1[User: 'What is AI?']
        O1[Orchestrator Analyzes]
        R1[Direct Response:<br/>'AI is artificial intelligence...']
        U1 --> O1 --> R1
    end

    subgraph WithTool[" TOOL REQUIRED SCENARIO "]
        U2[User: 'Go to Amazon']
        O2[Orchestrator Analyzes]
        T2[Call Automation Tool]
        B2[Browser Agent Executes]
        R2[Return Result]
        U2 --> O2 --> T2 --> B2 --> R2
    end

    style NoTool fill:#e8f5e9
    style WithTool fill:#fff3e0
```

---

## 🔄 Agent-to-Agent Communication

```mermaid
flowchart TB
    subgraph Level1[" LEVEL 1: ORCHESTRATOR AGENT "]
        OA[OpenAI Agent SDK<br/>GPT-4.1-mini<br/><br/>Responsibilities:<br/>• Conversation management<br/>• Tool selection<br/>• Response generation]
    end

    subgraph Level2[" LEVEL 2: BROWSER AGENT "]
        BA[browser-use Agent<br/>GPT-4o-mini<br/><br/>Responsibilities:<br/>• Action planning<br/>• Browser control<br/>• Data extraction]
    end

    OA -->|"Calls Automation tool<br/>Passes task string"| BA
    BA -->|"Returns result string<br/>e.g., 'Found laptop for $299'"| OA

    style Level1 fill:#f3e5f5
    style Level2 fill:#c8e6c9
```

---

## 👥 Human-in-the-Loop Flow

```mermaid
flowchart TB
    Start[Browser Agent Executing]
    Check{Need User Input?}

    Start --> Check

    Check -->|No| Continue[Continue Automation]

    Check -->|Need Info| Ask[ask_human tool<br/>'What is your email?']
    Ask --> Modal1[Show Modal in Extension]
    Modal1 --> UserInput1[User Types Response]
    UserInput1 --> Continue

    Check -->|Need 2FA| Wait[wait_for_2fa tool<br/>'Complete 2FA']
    Wait --> Modal2[Show 2FA Modal]
    Modal2 --> UserInput2[User Completes 2FA<br/>Clicks 'Done']
    UserInput2 --> Continue

    Check -->|Check Cancel| Cancel{User Clicked Stop?}
    Cancel -->|Yes| Stop[Stop Automation]
    Cancel -->|No| Continue

    Continue --> NextStep[Execute Next Step]
    NextStep --> Check

    style Ask fill:#ffccbc
    style Wait fill:#ffccbc
    style Cancel fill:#ffcdd2
```

---

## 💾 Database Schema

```mermaid
erDiagram
    USERS ||--o{ AUTOMATION_HISTORY : has
    USERS ||--o{ SCHEDULED_TASKS : has
    USERS ||--o{ AGENT_SESSIONS : has

    USERS {
        string email PK
        string password
        string username
        bool email_verified
    }

    AUTOMATION_HISTORY {
        string user_email FK
        string task_name
        enum status
        datetime start_time
        string final_result
    }

    SCHEDULED_TASKS {
        string user_email FK
        string automation_prompt
        enum frequency
        string schedule_time
        bool is_active
    }

    AGENT_SESSIONS {
        string session_id FK
        object item
        int sequence
    }
```

---

## 📡 Real-Time Streaming

```mermaid
sequenceDiagram
    participant E as Extension UI
    participant W as WebSocket
    participant B as Browser Agent

    B->>W: Step 1: Navigate to website
    W->>E: {type: "automation_step_realtime"}
    E->>E: Create step card

    B->>W: Action: navigate(url)
    W->>E: {type: "automation_step_update"}
    E->>E: Update step with action

    B->>W: Evaluation: Success
    W->>E: {type: "automation_step_update"}
    E->>E: Show success checkmark

    B->>W: Step 2: Click button
    W->>E: {type: "automation_step_realtime"}
    E->>E: Create new step card

    Note over E: User sees live progress<br/>as automation runs
```

---

## ⏰ Task Scheduler Integration

```mermaid
flowchart LR
    User[User Creates Task<br/>in Dashboard]
    API[REST API saves to MongoDB]
    Scheduler[APScheduler<br/>loads task]
    Trigger[Cron Trigger Fires<br/>at scheduled time]
    Execute[Calls execute_automation_task]
    BrowserAgent[Browser Agent Executes]

    User --> API
    API --> Scheduler
    Scheduler --> Trigger
    Trigger --> Execute
    Execute --> BrowserAgent
    BrowserAgent -.->|Result| API

    style Scheduler fill:#f0f4c3
    style Trigger fill:#fff9c4
```

---

## 🏗️ Technology Stack

```mermaid
mindmap
  root((Agent<br/>Architecture))
    Orchestrator
      OpenAI Agent SDK
      GPT-4.1-mini
      Function Tools
      Session Memory
    Browser Agent
      browser-use library
      GPT-4o-mini
      Playwright CDP
      Custom Actions
    HITL Tools
      ask_human
      wait_for_2fa
      cancellation
    Database
      MongoDB
      Motor async
      Session storage
    Streaming
      WebSocket
      Real-time updates
      Log handlers
```

---

## 📋 Complete User Journey

```mermaid
stateDiagram-v2
    [*] --> Login: User opens extension
    Login --> Connected: Authenticate
    Connected --> ChatReady: WebSocket connected

    ChatReady --> UserMessage: User types message

    UserMessage --> OrchestratorAnalysis: Send to agent

    state OrchestratorAnalysis {
        [*] --> LoadHistory
        LoadHistory --> AnalyzeIntent
        AnalyzeIntent --> MakeDecision
    }

    MakeDecision --> DirectAnswer: Simple question
    MakeDecision --> CallTool: Automation needed

    state DirectAnswer {
        [*] --> GenerateResponse
        GenerateResponse --> [*]
    }

    state CallTool {
        [*] --> CreateBrowserAgent
        CreateBrowserAgent --> ExecuteSteps
        ExecuteSteps --> HITL: Need input?
        HITL --> ExecuteSteps: Continue
        ExecuteSteps --> [*]: Complete
    }

    DirectAnswer --> StreamToUser
    CallTool --> StreamToUser

    StreamToUser --> ChatReady: Ready for next message

    ChatReady --> [*]: User closes
```

---

## 🎯 Key Architectural Benefits

| Feature                       | Benefit                                              |
| ----------------------------- | ---------------------------------------------------- |
| **Two-Level Agents**    | Orchestrator decides WHAT, Browser Agent decides HOW |
| **Tool Architecture**   | Easy to add new tools (Email, API, File operations)  |
| **Session Memory**      | Context-aware conversations across messages          |
| **HITL Integration**    | Seamless user interaction during automation          |
| **Real-Time Streaming** | Live progress updates, better UX                     |
| **Scheduled Tasks**     | Unattended automation at specific times              |

---

## 🚀 Example Scenarios

### Scenario 1: Simple Question (No Tool)

```
User: "What is browser automation?"

Orchestrator:
  ├─ Analyze: Knowledge question
  ├─ Decision: NO TOOL
  └─ Response: "Browser automation is..."

✅ Direct conversational response
```

### Scenario 2: Web Automation (Tool Required)

```
User: "Find cheapest laptop on Amazon"

Orchestrator:
  ├─ Analyze: Needs web interaction
  ├─ Decision: USE TOOL
  └─ Call: Automation("find cheapest laptop")
      │
      Browser Agent:
        ├─ Navigate to Amazon
        ├─ Search "laptop"
        ├─ Sort by price
        └─ Extract: "Lenovo - $299"

      Return to Orchestrator

  └─ Response: "I found Lenovo ThinkPad for $299"

✅ Automation executed, friendly result
```

### Scenario 3: Interactive Automation (HITL)

```
User: "Login to my email"

Orchestrator → Automation Tool → Browser Agent:
  ├─ Navigate to Gmail
  ├─ ask_human("Email?") → User: "john@example.com"
  ├─ Type email
  ├─ ask_human("Password?") → User: "********"
  ├─ Submit login
  ├─ wait_for_2fa() → User completes 2FA
  └─ Extract: "5 unread emails"

✅ Interactive automation with user input
```

---

This simplified version should render properly! The main diagram shows your complete system with focus on agent orchestration. 🎉
