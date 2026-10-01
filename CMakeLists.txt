cmake_minimum_required(VERSION 3.20)

project(qrs VERSION 0.2.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(qrs_core
    src/crc32c.cpp
    src/fec.cpp
    src/frame.cpp
    src/manifest.cpp
    src/optical.cpp
)
target_include_directories(qrs_core PUBLIC include)
target_compile_options(qrs_core PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall;-Wextra;-Wpedantic;-Wconversion>
    $<$<CXX_COMPILER_ID:MSVC>:/W4;/permissive->
)

add_executable(qrs_offline_demo tools/offline_demo.cpp)
target_link_libraries(qrs_offline_demo PRIVATE qrs_core)

enable_testing()
add_executable(qrs_tests tests/qrs_tests.cpp)
target_link_libraries(qrs_tests PRIVATE qrs_core)
add_test(NAME qrs_tests COMMAND qrs_tests)
