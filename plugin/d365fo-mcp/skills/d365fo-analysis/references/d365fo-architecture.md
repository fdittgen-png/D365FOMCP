# Part 1: D365FO Architecture

_Reference for the `d365fo-analysis` skill. Read on demand._


### 1.1 Package Structure

**PackagesLocalDirectory Layout:**
```
PackagesLocalDirectory\
├── ApplicationSuite\          # Core application
├── ApplicationFoundation\     # Base framework
├── ApplicationPlatform\       # Platform services
├── EngineeringChangeManagement\  # ECM module
├── [OtherModels]\
└── bin\                       # Compiled binaries
```

**Model Internal Structure:**
```
[ModelName]\
├── [ModelName]\               # Source metadata
│   ├── AxClass\              # X++ classes
│   ├── AxTable\              # Table definitions
│   ├── AxTableExtension\     # Table extensions
│   ├── AxDataEntityView\     # Data entities
│   ├── AxForm\               # Forms
│   ├── AxFormExtension\      # Form extensions
│   ├── AxEdt\                # Extended data types
│   ├── AxEnum\               # Enumerations
│   ├── AxQuery\              # Queries
│   ├── AxView\               # Views
│   ├── AxMap\                # Maps
│   ├── AxMenuItemAction\     # Action menu items
│   ├── AxMenuItemDisplay\    # Display menu items
│   ├── AxSecurityPrivilege\  # Security privileges
│   ├── AxSecurityDuty\       # Security duties
│   ├── AxSecurityRole\       # Security roles
│   ├── AxWorkflowTemplate\   # Workflows
│   └── AxLabelFile\          # Labels
├── Descriptor\               # Model metadata
├── XppMetadata\              # Compiled metadata
├── bin\                      # Model binaries
├── Reports\                  # SSRS reports
└── Resources\                # Embedded resources
```

### 1.2 Key Models and Dependencies

| Model | Purpose | Key Dependencies |
|-------|---------|------------------|
| ApplicationPlatform | Core platform services | None |
| ApplicationFoundation | Base framework | ApplicationPlatform |
| ApplicationSuite | Core business logic | ApplicationFoundation |
| EngineeringChangeManagement | Product lifecycle | ApplicationSuite |

### 1.3 Version Information

**Analyzed Version:** 10.0.2263.172
**Location:** `<PackagesLocalDirectory of build 10.0.2263.172>`

