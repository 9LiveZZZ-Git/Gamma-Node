# Build Gamma as a static library targeting WebAssembly.
# Adapted verbatim from AlloLib Studio Online's allolib-wasm/CMakeLists.txt
# (lines 80–115). Excludes AudioIO.cpp / Recorder.cpp / SoundFile.cpp
# which need PortAudio + libsndfile and aren't useful in the browser
# AudioWorklet path the editor uses.

cmake_minimum_required(VERSION 3.16)
project(gamma-wasm CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Use 'emcmake cmake ...' so EMSCRIPTEN is set.")
endif()

if(NOT DEFINED ENV{GAMMA_DIR} AND NOT DEFINED GAMMA_DIR)
    message(FATAL_ERROR
        "GAMMA_DIR not set. Either:\n"
        "  export GAMMA_DIR=/abs/path/to/Gamma\n"
        "  -OR-\n"
        "  emcmake cmake -DGAMMA_DIR=/abs/path/to/Gamma -B build-wasm -S .")
endif()
if(NOT DEFINED GAMMA_DIR)
    set(GAMMA_DIR "$ENV{GAMMA_DIR}")
endif()
message(STATUS "GAMMA_DIR = ${GAMMA_DIR}")

# Web-buildable Gamma sources. Excludes platform-coupled files.
set(GAMMA_SOURCES
    ${GAMMA_DIR}/src/Conversion.cpp
    ${GAMMA_DIR}/src/DFT.cpp
    ${GAMMA_DIR}/src/Domain.cpp
    ${GAMMA_DIR}/src/FFT_fftpack.cpp
    ${GAMMA_DIR}/src/Print.cpp
    ${GAMMA_DIR}/src/Scheduler.cpp
    ${GAMMA_DIR}/src/Timer.cpp
    ${GAMMA_DIR}/src/arr.cpp
    ${GAMMA_DIR}/src/fftpack++1.cpp
    ${GAMMA_DIR}/src/fftpack++2.cpp
    ${GAMMA_DIR}/src/scl.cpp
)

add_library(gamma STATIC ${GAMMA_SOURCES})

target_include_directories(gamma PUBLIC "${GAMMA_DIR}")

target_compile_options(gamma PRIVATE
    -Wno-deprecated-declarations
    -Wno-unused-variable
    -O2
)

set_target_properties(gamma PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)

# Output goes to build-wasm/libgamma.a by default. The wrapper script
# packages this plus the headers into assets/gamma-wasm-v1.tar.gz.
