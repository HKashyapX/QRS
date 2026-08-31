#include <iostream>
#include <vector>
#include <random>
#include <map>
#include <set>
#include <algorithm>

using namespace std;

const size_t CHUNK_SIZE = 64;

struct Droplet {
    uint32_t seed;
    vector<uint8_t> payload;
};

class FountainEncoder {
    vector<vector<uint8_t>> chunks;
    size_t k;
    uint32_t current_seed;
    mt19937 prng;

public:
    FountainEncoder(const vector<uint8_t>& data) : current_seed(1) {
        k = (data.size() + CHUNK_SIZE - 1) / CHUNK_SIZE;
        chunks.resize(k, vector<uint8_t>(CHUNK_SIZE, 0));
        for (size_t i = 0; i < data.size(); ++i) {
            chunks[i / CHUNK_SIZE][i % CHUNK_SIZE] = data[i];
        }
    }

    size_t get_k() const { return k; }

    Droplet generate_droplet() {
        Droplet d;
        d.seed = current_seed++;
        d.payload.resize(CHUNK_SIZE, 0);

        mt19937 gen(d.seed);
        
        int degree = 1;
        int pct = gen() % 100;
        if (pct > 40 && pct <= 80) degree = 2;
        else if (pct > 80) degree = (gen() % (k / 2 + 1)) + 1;
        
        degree = min(max(degree, 1), (int)k);

        vector<size_t> indices(k);
        for (size_t i = 0; i < k; ++i) indices[i] = i;
        shuffle(indices.begin(), indices.end(), gen);

        for (int i = 0; i < degree; ++i) {
            size_t idx = indices[i];
            for (size_t j = 0; j < CHUNK_SIZE; ++j) {
                d.payload[j] ^= chunks[idx][j];
            }
        }
        return d;
    }
};

class FountainDecoder {
    size_t k;
    vector<vector<uint8_t>> resolved_chunks;
    vector<bool> chunk_status;
    size_t chunks_resolved;

    struct Node {
        vector<uint8_t> payload;
        set<size_t> dependencies;
    };
    
    vector<Node> graph;

public:
    FountainDecoder(size_t k_val) : k(k_val), chunks_resolved(0) {
        resolved_chunks.resize(k, vector<uint8_t>(CHUNK_SIZE, 0));
        chunk_status.resize(k, false);
    }

    bool is_complete() const { return chunks_resolved == k; }

    void process_droplet(const Droplet& d) {
        if (is_complete()) return;

        mt19937 gen(d.seed);
        int degree = 1;
        int pct = gen() % 100;
        if (pct > 40 && pct <= 80) degree = 2;
        else if (pct > 80) degree = (gen() % (k / 2 + 1)) + 1;
        
        degree = min(max(degree, 1), (int)k);

        vector<size_t> indices(k);
        for (size_t i = 0; i < k; ++i) indices[i] = i;
        shuffle(indices.begin(), indices.end(), gen);

        Node node;
        node.payload = d.payload;
        for (int i = 0; i < degree; ++i) {
            node.dependencies.insert(indices[i]);
        }

        for (size_t i = 0; i < k; ++i) {
            if (chunk_status[i] && node.dependencies.count(i)) {
                for (size_t j = 0; j < CHUNK_SIZE; ++j) {
                    node.payload[j] ^= resolved_chunks[i][j];
                }
                node.dependencies.erase(i);
            }
        }

        if (node.dependencies.empty()) return;
        graph.push_back(node);
        propagate();
    }

    void propagate() {
        bool changed = true;
        while (changed) {
            changed = false;
            for (auto it = graph.begin(); it != graph.end(); ) {
                if (it->dependencies.size() == 1) {
                    size_t resolved_idx = *it->dependencies.begin();
                    if (!chunk_status[resolved_idx]) {
                        resolved_chunks[resolved_idx] = it->payload;
                        chunk_status[resolved_idx] = true;
                        chunks_resolved++;
                        
                        for (auto& other_node : graph) {
                            if (other_node.dependencies.count(resolved_idx)) {
                                for (size_t j = 0; j < CHUNK_SIZE; ++j) {
                                    other_node.payload[j] ^= resolved_chunks[resolved_idx][j];
                                }
                                other_node.dependencies.erase(resolved_idx);
                            }
                        }
                        changed = true;
                    }
                    it = graph.erase(it);
                } else if (it->dependencies.empty()) {
                    it = graph.erase(it);
                } else {
                    ++it;
                }
            }
        }
    }

    vector<uint8_t> get_result() {
        vector<uint8_t> out;
        for (const auto& chunk : resolved_chunks) {
            out.insert(out.end(), chunk.begin(), chunk.end());
        }
        return out;
    }
};

int main() {
    vector<uint8_t> original_data;
    for (int i = 0; i < 10000; ++i) {
        original_data.push_back(i % 256);
    }

    FountainEncoder encoder(original_data);
    FountainDecoder decoder(encoder.get_k());

    cout << "[TX] Total Chunks (K) = " << encoder.get_k() << "\n";
    cout << "[CH] Simulating optical air-gap with 30% frame drop rate...\n";

    mt19937 drop_gen(42);
    size_t tx_count = 0;
    size_t rx_count = 0;

    while (!decoder.is_complete()) {
        Droplet d = encoder.generate_droplet();
        tx_count++;

        if (drop_gen() % 100 < 30) {
            continue;
        }

        rx_count++;
        decoder.process_droplet(d);
    }

    cout << "[RX] Decoding Complete.\n";
    cout << "     Transmitted: " << tx_count << " droplets\n";
    cout << "     Received:    " << rx_count << " droplets\n";
    cout << "     Efficiency:  " << (float)encoder.get_k() / rx_count * 100.0 << "%\n";

    vector<uint8_t> decoded_data = decoder.get_result();
    
    bool match = true;
    for (size_t i = 0; i < original_data.size(); ++i) {
        if (original_data[i] != decoded_data[i]) {
            match = false;
            break;
        }
    }

    cout << "[SYS] Integrity Check: " << (match ? "PASS" : "FAIL") << "\n";
    return 0;
}
